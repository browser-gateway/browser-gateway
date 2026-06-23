/**
 * Screencast bridge between a provider (via CDP) and a dashboard (via WS).
 *
 * Lifecycle:
 *   1. setup(): open CDP, find/create a page target, attach flat-mode, enable
 *      Page domain, override device metrics, start screencast
 *   2. While running: forward provider's screencastFrame events as binary WS
 *      frames to the dashboard, ACK each frame BEFORE writing it out (spec
 *      §5.1.F — Chromium stalls the queue if acks lag); validate + forward
 *      dashboard input messages to provider as Input.* / Page.navigate
 *   3. close(): stop screencast, detach, close both sockets
 *
 * Backpressure: if the dashboard's `bufferedAmount` exceeds DROP_THRESHOLD we
 * SKIP that frame's send to dashboard but still ack upstream, so the provider
 * keeps streaming and we don't OOM holding frames in memory (spec §5.1.J).
 *
 * NEVER REGRESS — three critical details from the spec's anti-list (§8):
 *   - The frame `sessionId` is an INTEGER (frame counter), the envelope
 *     `sessionId` is a STRING (attach session). Don't conflate.
 *   - Ack synchronously before forwarding the frame, not after.
 *   - Call `Page.setDeviceMetricsOverride` BEFORE `startScreencast` in
 *     headless or frames come back at the wrong size (puppeteer #10527).
 */
import type { Logger } from "pino";
import type WebSocket from "ws";
import { CdpClient, CdpError } from "./cdp-client.js";
import {
  ClientMessageSchema,
  type ClientMessage,
  type ServerControlMessage,
} from "./types.js";

export interface BridgeOptions {
  /** Provider's browser-level CDP WebSocket URL. */
  providerWsUrl: string;
  /** JPEG/PNG. Default jpeg. */
  format?: "jpeg" | "png";
  /** Default 60. JPEG only. */
  quality?: number;
  /** Default 1280. */
  maxWidth?: number;
  /** Default 720. */
  maxHeight?: number;
  /** Default 2 (~12 FPS at typical Chrome capture rates). */
  everyNthFrame?: number;
  /** Default 1. */
  deviceScaleFactor?: number;
  /** Drop frame if dashboard buffered bytes exceeds this. Default 1 MB. */
  dropThresholdBytes?: number;
  logger: Logger;
}

const DEFAULT_OPTS = {
  format: "jpeg" as const,
  quality: 60,
  maxWidth: 1280,
  maxHeight: 720,
  everyNthFrame: 2,
  deviceScaleFactor: 1,
  dropThresholdBytes: 1_000_000,
};

interface ScreencastFrameParams {
  data: string;
  metadata: {
    offsetTop: number;
    pageScaleFactor: number;
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
    timestamp?: number;
  };
  /** INTEGER frame counter — pass to screencastFrameAck verbatim. */
  sessionId: number;
}

export class ScreencastBridge {
  private readonly opts: Required<Omit<BridgeOptions, "logger">> & { logger: Logger };
  private readonly cdp: CdpClient;
  private dashboardWs: WebSocket | null = null;
  /** Flat-mode session id from Target.attachToTarget — a STRING. */
  private attachSessionId: string | null = null;
  private targetId: string | null = null;
  private framesSent = 0;
  private framesDropped = 0;
  private closed = false;
  private cleanupFns: Array<() => void> = [];

  constructor(opts: BridgeOptions) {
    this.opts = {
      providerWsUrl: opts.providerWsUrl,
      format: opts.format ?? DEFAULT_OPTS.format,
      quality: opts.quality ?? DEFAULT_OPTS.quality,
      maxWidth: opts.maxWidth ?? DEFAULT_OPTS.maxWidth,
      maxHeight: opts.maxHeight ?? DEFAULT_OPTS.maxHeight,
      everyNthFrame: opts.everyNthFrame ?? DEFAULT_OPTS.everyNthFrame,
      deviceScaleFactor: opts.deviceScaleFactor ?? DEFAULT_OPTS.deviceScaleFactor,
      dropThresholdBytes: opts.dropThresholdBytes ?? DEFAULT_OPTS.dropThresholdBytes,
      logger: opts.logger,
    };
    this.cdp = new CdpClient();
  }

  /** Test/observability. */
  getStats() {
    return { framesSent: this.framesSent, framesDropped: this.framesDropped };
  }

  /** Expose CDP client + flat-mode session id so a sibling module (e.g. lazy
   *  hydration on Page.frameNavigated) can install listeners on the same
   *  attached target the bridge owns. Only valid after `setup()` resolves. */
  getCdpAndSession(): { cdp: CdpClient; sessionId: string } | null {
    if (!this.attachSessionId) return null;
    return { cdp: this.cdp, sessionId: this.attachSessionId };
  }

  /**
   * Open the CDP session, attach, prep, and start the screencast.
   * Throws on any setup failure. Caller should then call `attachDashboard`.
   */
  async setup(): Promise<void> {
    await this.cdp.connect(this.opts.providerWsUrl);

    // Always create a FRESH target. Reusing an existing tab made stale state
    // leak between playground sessions — the user would refresh the dashboard
    // and see the previous page again. Each playground session now owns its
    // own tab end-to-end, closed on disconnect so the provider's Chrome
    // doesn't accumulate orphan tabs.
    const created = await this.cdp.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    this.targetId = created.targetId;

    // Attach flat-mode. The string sessionId tags subsequent envelopes.
    const attached = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: this.targetId,
      flatten: true,
    });
    this.attachSessionId = attached.sessionId;

    // Page domain for frame nav events.
    await this.cdp.send("Page.enable", {}, this.attachSessionId);

    // setDeviceMetricsOverride BEFORE startScreencast — puppeteer #10527.
    await this.cdp.send(
      "Page.setDeviceMetricsOverride",
      {
        width: this.opts.maxWidth,
        height: this.opts.maxHeight,
        deviceScaleFactor: this.opts.deviceScaleFactor,
        mobile: false,
      },
      this.attachSessionId,
    );

    // Wire event listener BEFORE starting the screencast so we don't miss frames.
    const offEvent = this.cdp.on((event) => this.handleCdpEvent(event));
    this.cleanupFns.push(offEvent);

    await this.cdp.send(
      "Page.startScreencast",
      {
        format: this.opts.format,
        quality: this.opts.quality,
        maxWidth: this.opts.maxWidth,
        maxHeight: this.opts.maxHeight,
        everyNthFrame: this.opts.everyNthFrame,
      },
      this.attachSessionId,
    );

    // If the provider dies, close ourselves.
    const offClose = this.cdp.onClose(() => {
      this.opts.logger.info({ targetId: this.targetId }, "live: provider CDP closed");
      this.close();
    });
    this.cleanupFns.push(offClose);
  }

  /** Wire the dashboard WS for bidirectional traffic. */
  attachDashboard(ws: WebSocket): void {
    this.dashboardWs = ws;
    ws.on("message", (raw) => {
      this.handleDashboardMessage(raw.toString("utf8"));
    });
    ws.on("close", () => this.close());
    ws.on("error", (err) => {
      this.opts.logger.warn({ err: err.message }, "live: dashboard ws error");
      this.close();
    });
  }

  private handleCdpEvent(event: { method: string; sessionId?: string; params: Record<string, unknown> }): void {
    if (event.method === "Page.screencastFrame") {
      const p = event.params as unknown as ScreencastFrameParams;

      // Step 1: ACK first (synchronously). The integer sessionId is the frame
      // counter from the event payload — NOT our attach session.
      this.cdp.sendMayFail(
        "Page.screencastFrameAck",
        { sessionId: p.sessionId },
        this.attachSessionId ?? undefined,
      );

      // Step 2: emit a frameMeta message if dimensions changed (or first frame).
      this.maybeSendFrameMeta(p.metadata);

      // Step 3: forward frame to dashboard, respecting backpressure.
      this.forwardFrame(p.data);
      return;
    }

    if (event.method === "Page.frameNavigated") {
      const params = event.params as { frame?: { url?: string; parentId?: string } };
      if (params.frame && !params.frame.parentId && params.frame.url) {
        this.sendControlMessage({ type: "url", url: params.frame.url });
      }
    }
  }

  private lastMeta: { deviceWidth: number; deviceHeight: number; scrollX: number; scrollY: number } | null = null;
  private maybeSendFrameMeta(metadata: ScreencastFrameParams["metadata"]): void {
    const next = {
      deviceWidth: metadata.deviceWidth,
      deviceHeight: metadata.deviceHeight,
      scrollX: metadata.scrollOffsetX,
      scrollY: metadata.scrollOffsetY,
    };
    if (
      this.lastMeta &&
      this.lastMeta.deviceWidth === next.deviceWidth &&
      this.lastMeta.deviceHeight === next.deviceHeight &&
      this.lastMeta.scrollX === next.scrollX &&
      this.lastMeta.scrollY === next.scrollY
    ) {
      return;
    }
    this.lastMeta = next;
    this.sendControlMessage({ type: "frameMeta", ...next });
  }

  private forwardFrame(base64Data: string): void {
    if (!this.dashboardWs || this.dashboardWs.readyState !== this.dashboardWs.OPEN) return;
    if (this.dashboardWs.bufferedAmount > this.opts.dropThresholdBytes) {
      this.framesDropped++;
      return;
    }
    try {
      const bytes = Buffer.from(base64Data, "base64");
      this.dashboardWs.send(bytes, { binary: true });
      this.framesSent++;
    } catch {
      // best-effort
    }
  }

  private sendControlMessage(msg: ServerControlMessage): void {
    if (!this.dashboardWs || this.dashboardWs.readyState !== this.dashboardWs.OPEN) return;
    try {
      this.dashboardWs.send(JSON.stringify(msg));
    } catch {
      // best-effort
    }
  }

  private handleDashboardMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const result = ClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.opts.logger.warn(
        { issues: result.error.issues.slice(0, 3) },
        "live: rejected invalid dashboard message",
      );
      return;
    }
    void this.dispatchClientMessage(result.data);
  }

  private async dispatchClientMessage(msg: ClientMessage): Promise<void> {
    if (!this.attachSessionId) return;
    try {
      switch (msg.type) {
        case "mouse":
          await this.cdp.send(
            "Input.dispatchMouseEvent",
            {
              type:
                msg.event.kind === "press" ? "mousePressed"
                : msg.event.kind === "release" ? "mouseReleased"
                : msg.event.kind === "wheel" ? "mouseWheel"
                : "mouseMoved",
              x: msg.event.x,
              y: msg.event.y,
              button: msg.event.button ?? "left",
              // Steel's simplification: if button is "none", buttons=0; else 1.
              buttons: !msg.event.button || msg.event.button === "none" ? 0 : 1,
              clickCount: msg.event.clickCount ?? (msg.event.kind === "press" || msg.event.kind === "release" ? 1 : 0),
              modifiers: msg.event.modifiers ?? 0,
              ...(msg.event.kind === "wheel"
                ? { deltaX: msg.event.deltaX ?? 0, deltaY: msg.event.deltaY ?? 0 }
                : {}),
            },
            this.attachSessionId,
          );
          break;
        case "key":
          await this.cdp.send(
            "Input.dispatchKeyEvent",
            {
              type:
                msg.event.kind === "down" ? "keyDown"
                : msg.event.kind === "up" ? "keyUp"
                : "char",
              ...(msg.event.text !== undefined ? { text: msg.event.text, unmodifiedText: msg.event.text.toLowerCase() } : {}),
              ...(msg.event.code ? { code: msg.event.code } : {}),
              ...(msg.event.key ? { key: msg.event.key } : {}),
              ...(msg.event.keyCode !== undefined
                ? { windowsVirtualKeyCode: msg.event.keyCode, nativeVirtualKeyCode: msg.event.keyCode }
                : {}),
              modifiers: msg.event.modifiers ?? 0,
              autoRepeat: false,
              isKeypad: false,
              isSystemKey: false,
            },
            this.attachSessionId,
          );
          break;
        case "navigate":
          if (msg.url) {
            await this.cdp.send("Page.navigate", { url: msg.url }, this.attachSessionId);
          } else if (msg.action === "reload") {
            await this.cdp.send("Page.reload", {}, this.attachSessionId);
          } else if (msg.action === "back" || msg.action === "forward") {
            const hist = await this.cdp.send<{ currentIndex: number; entries: { id: number }[] }>(
              "Page.getNavigationHistory",
              {},
              this.attachSessionId,
            );
            const targetIdx = hist.currentIndex + (msg.action === "back" ? -1 : 1);
            const entry = hist.entries[targetIdx];
            if (entry) {
              await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, this.attachSessionId);
            }
          }
          break;
        case "setViewport":
          await this.cdp.send(
            "Page.setDeviceMetricsOverride",
            {
              width: msg.width,
              height: msg.height,
              deviceScaleFactor: msg.deviceScaleFactor ?? 1,
              mobile: msg.mobile ?? false,
            },
            this.attachSessionId,
          );
          this.opts.maxWidth = msg.width;
          this.opts.maxHeight = msg.height;
          // Restart screencast so subsequent frames are sized correctly.
          this.cdp.sendMayFail("Page.stopScreencast", {}, this.attachSessionId);
          await this.cdp.send(
            "Page.startScreencast",
            {
              format: this.opts.format,
              quality: this.opts.quality,
              maxWidth: msg.width,
              maxHeight: msg.height,
              everyNthFrame: this.opts.everyNthFrame,
            },
            this.attachSessionId,
          );
          break;
        case "paste":
          // Input.insertText commits text directly to the focused element, no
          // per-character key dispatch. Matches what Chrome's own paste does.
          await this.cdp.send("Input.insertText", { text: msg.text }, this.attachSessionId);
          break;
        case "close":
          this.close();
          break;
      }
    } catch (err) {
      if (err instanceof CdpError) {
        this.opts.logger.warn(
          { code: err.code, message: err.message.slice(0, 120), type: msg.type },
          "live: CDP error dispatching client message",
        );
      } else {
        this.opts.logger.warn(
          { err: err instanceof Error ? err.message : String(err), type: msg.type },
          "live: error dispatching client message",
        );
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const fn of this.cleanupFns) {
      try { fn(); } catch {}
    }
    this.cleanupFns = [];

    if (this.attachSessionId && !this.cdp.isClosed()) {
      this.cdp.sendMayFail("Page.stopScreencast", {}, this.attachSessionId);
      this.cdp.sendMayFail("Target.detachFromTarget", { sessionId: this.attachSessionId });
    }
    // Close the tab we created in setup() so the provider's Chrome doesn't
    // accumulate orphans. Browser-level call (no sessionId envelope).
    if (this.targetId && !this.cdp.isClosed()) {
      this.cdp.sendMayFail("Target.closeTarget", { targetId: this.targetId });
    }
    this.cdp.close();

    try { this.dashboardWs?.close(1000, "stream ended"); } catch {}
    this.dashboardWs = null;
  }
}

