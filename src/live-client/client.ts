/**
 * Browser-side client for the gateway's `/v1/live` WebSocket.
 *
 * Protocol shape lives in `./protocol.ts`. Both OSS gateway dashboard and the
 * SaaS cloud playground import this class — one implementation, zero drift.
 *
 * Server→client: binary WS frames carry JPEG bytes; JSON text frames carry
 * control messages (`frameMeta`, `url`, `error`). Client→server: JSON text
 * frames for mouse / key / navigate / close / setViewport / paste.
 *
 * No automatic reconnect. If the connection dies the UI surfaces the error
 * and the user reconnects manually.
 */

const MODIFIER_ALT = 1;
const MODIFIER_CTRL = 2;
const MODIFIER_META = 4;
const MODIFIER_SHIFT = 8;

export interface FrameMeta {
  deviceWidth: number;
  deviceHeight: number;
  scrollX: number;
  scrollY: number;
}

export interface LiveClientEvents {
  onFrame: (bitmap: ImageBitmap, meta: FrameMeta) => void;
  onUrl: (url: string) => void;
  onError: (code: string, message: string) => void;
  onClose: (info: { code: number; reason: string }) => void;
  onOpen: () => void;
  /** Fired when the server signals the keep-alive window is about to expire.
   *  Optional; hosts that don't opt in to `keepAliveSeconds` can ignore it. */
  onExpiring?: (secondsRemaining: number) => void;
  /** Fired when the server has hit the keep-alive limit. A close follows. */
  onExpired?: () => void;
}

export interface ConnectOpts {
  /** Base WS URL — e.g. `wss://cdp.browsergateway.io`. Derived from
   *  `window.location` when omitted. Set this on SaaS where the router lives
   *  on a different host than the dashboard. */
  wsBase?: string;
  /** Required: the chosen provider id. */
  provider: string;
  /** Optional profile id. When set, server injects cookies/storage. */
  profile?: string;
  /** Optional read-only profile flag — no lock, no writeback. */
  readOnly?: boolean;
  /** Auth token. In OSS this is `BG_TOKEN`; in SaaS this is a `bg_` router key. */
  token?: string | null;
  /** Screencast tuning — server enforces clamps. */
  format?: "jpeg" | "png";
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
  /** Hard session-duration cap in seconds. Server clamps to [60, 1200]. Omit
   *  to disable. When enabled, the server sends `expiring` at T-30s and
   *  `expired` at T-0, then closes the connection. */
  keepAliveSeconds?: number;
}

export class LiveClient {
  private ws: WebSocket | null = null;
  private currentMeta: FrameMeta | null = null;
  private listeners: LiveClientEvents;
  private closed = false;

  constructor(listeners: LiveClientEvents) {
    this.listeners = listeners;
  }

  connect(opts: ConnectOpts): void {
    if (this.ws) throw new Error("LiveClient already connected");

    const wsBase = opts.wsBase ?? deriveWsBase();
    const params = new URLSearchParams({ provider: opts.provider });
    if (opts.profile) params.set("profile", opts.profile);
    if (opts.readOnly) params.set("readOnly", "1");
    if (opts.token) {
      // SaaS router auth uses `?key=`; OSS uses `?token=`. Send both so a
      // single client works against either gateway. The server that doesn't
      // recognize a param just ignores it.
      params.set("key", opts.token);
      params.set("token", opts.token);
    }
    if (opts.format) params.set("format", opts.format);
    if (opts.quality !== undefined) params.set("quality", String(opts.quality));
    if (opts.maxWidth !== undefined) params.set("maxWidth", String(opts.maxWidth));
    if (opts.maxHeight !== undefined) params.set("maxHeight", String(opts.maxHeight));
    if (opts.everyNthFrame !== undefined)
      params.set("everyNthFrame", String(opts.everyNthFrame));
    if (opts.keepAliveSeconds !== undefined)
      params.set("keepAlive", String(opts.keepAliveSeconds));

    const url = `${wsBase}/v1/live?${params.toString()}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (this.closed) return;
      this.listeners.onOpen();
    });

    ws.addEventListener("message", (ev) => {
      if (this.closed) return;
      if (ev.data instanceof ArrayBuffer) {
        void this.handleBinaryFrame(ev.data);
      } else if (typeof ev.data === "string") {
        this.handleControlMessage(ev.data);
      }
    });

    ws.addEventListener("error", () => {
      // 'error' is opaque in browsers — the close event that follows carries
      // the useful info.
    });

    ws.addEventListener("close", (ev) => {
      if (this.closed) return;
      this.closed = true;
      this.listeners.onClose({ code: ev.code, reason: ev.reason });
      this.ws = null;
    });
  }

  private isProcessingFrame = false;
  private pendingFrameBuffer: ArrayBuffer | null = null;
  private pendingFrameDropped = 0;

  private handleBinaryFrame(buffer: ArrayBuffer): void {
    if (this.isProcessingFrame) {
      if (this.pendingFrameBuffer) this.pendingFrameDropped++;
      this.pendingFrameBuffer = buffer;
      return;
    }
    this.isProcessingFrame = true;
    void this.drainFrames(buffer);
  }

  private async drainFrames(first: ArrayBuffer): Promise<void> {
    try {
      await this.decodeAndDeliver(first);
      while (this.pendingFrameBuffer) {
        const next = this.pendingFrameBuffer;
        this.pendingFrameBuffer = null;
        await this.decodeAndDeliver(next);
      }
    } finally {
      this.isProcessingFrame = false;
    }
  }

  private async decodeAndDeliver(buffer: ArrayBuffer): Promise<void> {
    try {
      const blob = new Blob([buffer], { type: "image/jpeg" });
      const bitmap = await createImageBitmap(blob);
      const meta = this.currentMeta ?? {
        deviceWidth: bitmap.width,
        deviceHeight: bitmap.height,
        scrollX: 0,
        scrollY: 0,
      };
      this.listeners.onFrame(bitmap, meta);
    } catch {
      // Decoder failure on one frame shouldn't kill the stream.
    }
  }

  private handleControlMessage(text: string): void {
    let msg: {
      type?: string;
      deviceWidth?: number;
      deviceHeight?: number;
      scrollX?: number;
      scrollY?: number;
      url?: string;
      code?: string;
      message?: string;
      secondsRemaining?: number;
    };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (
      msg.type === "frameMeta" &&
      typeof msg.deviceWidth === "number" &&
      typeof msg.deviceHeight === "number"
    ) {
      this.currentMeta = {
        deviceWidth: msg.deviceWidth,
        deviceHeight: msg.deviceHeight,
        scrollX: msg.scrollX ?? 0,
        scrollY: msg.scrollY ?? 0,
      };
      return;
    }
    if (msg.type === "url" && typeof msg.url === "string") {
      this.listeners.onUrl(msg.url);
      return;
    }
    if (msg.type === "error") {
      this.listeners.onError(msg.code ?? "UNKNOWN", msg.message ?? "");
      return;
    }
    if (msg.type === "expiring" && typeof msg.secondsRemaining === "number") {
      this.listeners.onExpiring?.(msg.secondsRemaining);
      return;
    }
    if (msg.type === "expired") {
      this.listeners.onExpired?.();
      return;
    }
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getMeta(): FrameMeta | null {
    return this.currentMeta;
  }

  sendMouse(opts: {
    kind: "press" | "release" | "move" | "wheel";
    x: number;
    y: number;
    button?: "left" | "right" | "middle" | "none";
    modifiers?: number;
    clickCount?: number;
    deltaX?: number;
    deltaY?: number;
  }): void {
    this.send({ type: "mouse", event: opts });
  }

  sendKey(opts: {
    kind: "down" | "up" | "char";
    text?: string;
    code?: string;
    key?: string;
    keyCode?: number;
    modifiers?: number;
  }): void {
    this.send({ type: "key", event: opts });
  }

  /** Paste text into the focused field on the remote page. Uses CDP
   *  Input.insertText (one shot, no per-character key dispatch). Server caps
   *  length at 64 KB. */
  sendPaste(text: string): void {
    if (!text) return;
    this.send({ type: "paste", text: text.slice(0, 64_000) });
  }

  navigate(url: string): void {
    this.send({ type: "navigate", url });
  }

  navAction(action: "back" | "forward" | "reload"): void {
    this.send({ type: "navigate", action });
  }

  setViewport(width: number, height: number): void {
    this.send({ type: "setViewport", width, height });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close(1000);
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private send(obj: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {
      // best-effort
    }
  }
}

function deriveWsBase(): string {
  if (typeof window === "undefined") return "ws://localhost:9500";
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  // OSS dev-mode: dashboard on :9501 → gateway on :9500.
  const host = window.location.host.includes("9501")
    ? window.location.host.replace("9501", "9500")
    : window.location.host;
  return `${scheme}://${host}`;
}

/**
 * Convert a browser KeyboardEvent / MouseEvent / WheelEvent into the modifier
 * bitmask CDP expects. Exported so consumers can reuse it for both keydown and
 * mousedown paths.
 */
export function eventModifiers(
  e: KeyboardEvent | MouseEvent | WheelEvent,
): number {
  let mask = 0;
  if (e.altKey) mask |= MODIFIER_ALT;
  if (e.ctrlKey) mask |= MODIFIER_CTRL;
  if (e.metaKey) mask |= MODIFIER_META;
  if (e.shiftKey) mask |= MODIFIER_SHIFT;
  return mask;
}

/** Map a DOM `MouseEvent.button` (0/1/2) to our protocol button name. */
export function mouseButton(button: number): "left" | "right" | "middle" {
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "left";
}
