import { mkdirSync, writeFileSync, openSync, fsyncSync, closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ReplayConfig } from "../../core/types.js";
import type { CdpEvent } from "../live/cdp-client.js";
import { CdpClient } from "../live/cdp-client.js";
import type { ReplayMeta } from "./types.js";

export interface ReplayCaptureOpts {
  sessionId: string;
  providerId: string;
  providerWsUrl: string;
  profileId?: string;
  storePath: string;
  config: ReplayConfig;
  logger: Logger;
}

interface TargetState {
  targetId: string;
  attachSessionId: string;
  frameCount: number;
  sizeBytes: number;
  manifestFd: number;
  dir: string;
  lastUrl?: string;
}

const QUEUE_MAX = 200;

export class ReplayCapture {
  private readonly cdp = new CdpClient();
  private readonly sessionDir: string;
  private readonly targets = new Map<string, TargetState>();
  private writeQueue = 0;
  private droppedFrames = 0;
  private totalBytes = 0;
  private capStopped = false;
  private cleanupFns: Array<() => void> = [];

  constructor(private readonly opts: ReplayCaptureOpts) {
    this.sessionDir = join(opts.storePath, opts.sessionId);
  }

  async start(): Promise<void> {
    mkdirSync(this.sessionDir, { recursive: true });
    mkdirSync(join(this.sessionDir, "targets"), { recursive: true });

    const meta: ReplayMeta = {
      sessionId: this.opts.sessionId,
      providerId: this.opts.providerId,
      profileId: this.opts.profileId,
      startedAt: Date.now(),
      frameCount: 0,
      sizeBytes: 0,
      complete: false,
    };
    writeFileSync(join(this.sessionDir, "meta.json"), JSON.stringify(meta));

    try {
      await this.cdp.connect(this.opts.providerWsUrl, 10_000);
    } catch (err) {
      this.opts.logger.warn(
        { sessionId: this.opts.sessionId, err: errMsg(err) },
        "replay: cdp connect failed, capture disabled for this session",
      );
      return;
    }

    const offEvent = this.cdp.on((event) => this.handleEvent(event));
    this.cleanupFns.push(offEvent);

    const offClose = this.cdp.onClose(() => {
      this.opts.logger.debug({ sessionId: this.opts.sessionId }, "replay: cdp closed");
    });
    this.cleanupFns.push(offClose);

    this.cdp.sendMayFail("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });

    try {
      const list = await this.cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>(
        "Target.getTargets",
      );
      for (const ti of list.targetInfos) {
        if (ti.type === "page" || ti.type === "iframe") {
          this.attachToTarget(ti.targetId).catch((err) =>
            this.opts.logger.debug({ targetId: ti.targetId, err: errMsg(err) }, "replay: attach failed"),
          );
        }
      }
    } catch (err) {
      this.opts.logger.debug({ err: errMsg(err) }, "replay: getTargets failed");
    }
  }

  async finish(): Promise<{ frameCount: number; sizeBytes: number; droppedFrames: number }> {
    if (this.capStopped) {
      return { frameCount: 0, sizeBytes: this.totalBytes, droppedFrames: this.droppedFrames };
    }
    this.capStopped = true;

    let totalFrames = 0;
    for (const target of this.targets.values()) {
      this.cdp.sendMayFail("Page.stopScreencast", {}, target.attachSessionId);
      totalFrames += target.frameCount;
      try {
        fsyncSync(target.manifestFd);
        closeSync(target.manifestFd);
      } catch { /* ok */ }
    }

    for (const off of this.cleanupFns) off();
    this.cleanupFns = [];
    this.cdp.close();

    const endedAt = Date.now();
    try {
      writeFileSync(
        join(this.sessionDir, "complete.json"),
        JSON.stringify({ endedAt, frameCount: totalFrames, sizeBytes: this.totalBytes, droppedFrames: this.droppedFrames }),
      );
    } catch (err) {
      this.opts.logger.warn({ err: errMsg(err) }, "replay: failed to write complete.json");
    }

    return { frameCount: totalFrames, sizeBytes: this.totalBytes, droppedFrames: this.droppedFrames };
  }

  private async attachToTarget(targetId: string): Promise<void> {
    if (this.targets.has(targetId)) return;
    if (this.capStopped) return;

    let attachSessionId: string;
    try {
      const r = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      attachSessionId = r.sessionId;
    } catch (err) {
      this.opts.logger.debug({ targetId, err: errMsg(err) }, "replay: attach failed");
      return;
    }

    const dir = join(this.sessionDir, "targets", targetId);
    mkdirSync(dir, { recursive: true });
    const manifestFd = openSync(join(dir, "manifest.jsonl"), "a");

    const state: TargetState = {
      targetId,
      attachSessionId,
      frameCount: 0,
      sizeBytes: 0,
      manifestFd,
      dir,
    };
    this.targets.set(targetId, state);

    this.cdp.sendMayFail("Page.enable", {}, attachSessionId);

    this.cdp.sendMayFail(
      "Page.startScreencast",
      {
        format: this.opts.config.capture.format,
        quality: this.opts.config.capture.quality,
        everyNthFrame: this.opts.config.capture.everyNthFrame,
      },
      attachSessionId,
    );
  }

  private handleEvent(event: CdpEvent): void {
    if (event.method === "Target.attachedToTarget") {
      const params = event.params as { sessionId?: string; targetInfo?: { targetId: string; type: string } };
      const ti = params.targetInfo;
      if (ti && (ti.type === "page" || ti.type === "iframe")) {
        this.attachToTarget(ti.targetId).catch((err) =>
          this.opts.logger.debug({ targetId: ti.targetId, err: errMsg(err) }, "replay: auto-attach failed"),
        );
      }
      return;
    }

    if (event.method === "Target.detachedFromTarget") {
      const params = event.params as { sessionId?: string };
      for (const [, target] of this.targets) {
        if (target.attachSessionId === params.sessionId) {
          try { closeSync(target.manifestFd); } catch { /* ok */ }
          this.targets.delete(target.targetId);
          break;
        }
      }
      return;
    }

    if (event.method === "Page.frameNavigated") {
      const params = event.params as { frame?: { url?: string; parentId?: string } };
      const target = this.targetForSession(event.sessionId);
      if (target && params.frame && !params.frame.parentId && params.frame.url) {
        target.lastUrl = params.frame.url;
      }
      return;
    }

    if (event.method === "Page.screencastFrame") {
      this.handleScreencastFrame(event);
      return;
    }
  }

  private handleScreencastFrame(event: CdpEvent): void {
    const target = this.targetForSession(event.sessionId);
    if (!target) return;

    const params = event.params as {
      data: string;
      sessionId: number;
      metadata?: {
        timestamp?: number;
        deviceWidth?: number;
        deviceHeight?: number;
        scrollOffsetX?: number;
        scrollOffsetY?: number;
      };
    };

    this.cdp.sendMayFail("Page.screencastFrameAck", { sessionId: params.sessionId }, target.attachSessionId);

    if (this.totalBytes >= this.opts.config.maxBytesPerSession) {
      if (!this.capStopped) {
        this.opts.logger.warn(
          { sessionId: this.opts.sessionId, totalBytes: this.totalBytes },
          "replay: per-session byte cap reached, stopping capture",
        );
        this.capStopped = true;
        for (const t of this.targets.values()) {
          this.cdp.sendMayFail("Page.stopScreencast", {}, t.attachSessionId);
        }
      }
      return;
    }

    if (this.writeQueue >= QUEUE_MAX) {
      this.droppedFrames++;
      return;
    }

    this.writeQueue++;
    const buf = Buffer.from(params.data, "base64");
    target.frameCount++;
    const frameNum = target.frameCount;

    void this.persistFrame(target, frameNum, buf, params.metadata ?? {})
      .catch((err) => this.opts.logger.debug({ err: errMsg(err) }, "replay: persist failed"))
      .finally(() => { this.writeQueue--; });
  }

  private async persistFrame(
    target: TargetState,
    frameNum: number,
    buf: Buffer,
    metadata: {
      timestamp?: number;
      deviceWidth?: number;
      deviceHeight?: number;
      scrollOffsetX?: number;
      scrollOffsetY?: number;
    },
  ): Promise<void> {
    const padded = String(frameNum).padStart(6, "0");
    const ext = this.opts.config.capture.format === "jpeg" ? "jpeg" : "png";
    const framePath = join(target.dir, `${padded}.${ext}`);

    writeFileSync(framePath, buf);

    const record = {
      frame: frameNum,
      ts: typeof metadata.timestamp === "number" ? metadata.timestamp * 1000 : Date.now(),
      url: target.lastUrl ?? "",
      deviceWidth: metadata.deviceWidth ?? 0,
      deviceHeight: metadata.deviceHeight ?? 0,
      scrollX: metadata.scrollOffsetX ?? 0,
      scrollY: metadata.scrollOffsetY ?? 0,
      sizeBytes: buf.length,
    };
    const line = JSON.stringify(record) + "\n";
    writeSync(target.manifestFd, line);

    target.sizeBytes += buf.length;
    this.totalBytes += buf.length;
  }

  private targetForSession(cdpSessionId: string | undefined): TargetState | null {
    if (!cdpSessionId) return null;
    for (const target of this.targets.values()) {
      if (target.attachSessionId === cdpSessionId) return target;
    }
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
