/**
 * Minimal raw-WebSocket CDP client for the live-view feature.
 *
 * NOT a puppeteer replacement. The set of CDP methods we send is small (≈5),
 * and we don't want to pay the puppeteer-core install cost just to bridge a
 * screencast. This is the smallest correct flat-mode client we can ship.
 *
 * Flat mode (`Target.attachToTarget({ flatten: true })`): subsequent commands
 * include a top-level `sessionId: <string>` on the JSON envelope; responses
 * and events for that target carry the same `sessionId`. See spec §1.5.
 *
 * Critical detail: the `sessionId` returned by `attachToTarget` is a **string**
 * used to tag the envelope. The `sessionId` on `Page.screencastFrame` events
 * is a **number** (frame counter). They are different fields with the same
 * name. See spec §0 and the anti-list in §8.
 */
import WebSocket from "ws";

interface CdpEnvelope {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface CdpEvent {
  method: string;
  /** The flat-mode envelope sessionId (string), if present. */
  sessionId?: string;
  params: Record<string, unknown>;
}

export class CdpError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = "CdpError";
  }
}

type EventListener = (event: CdpEvent) => void;
type CloseListener = (info: { code: number; reason: string }) => void;

export class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private closed = false;

  /** Open WS to `wsUrl`. Rejects on connect failure / timeout. */
  async connect(wsUrl: string, timeoutMs = 10_000): Promise<void> {
    if (this.ws) throw new Error("CdpClient already connected");
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.terminate(); } catch {}
        reject(new Error(`CDP connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.once("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        ws.on("message", (data) => this.handleMessage(data));
        ws.on("close", (code, reasonBuf) => {
          const reason = reasonBuf.toString("utf8");
          this.handleClose(code, reason);
        });
        ws.on("error", (err) => {
          // After connect, errors aren't fatal here — close handles teardown.
          this.handleError(err);
        });
        resolve();
      });

      ws.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Send a CDP command, optionally scoped to a flat-mode session. Resolves
   * with `result`. Rejects with `CdpError` if the peer returns an error.
   */
  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 10_000,
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP not connected (sending ${method})`));
    }
    const id = this.nextId++;
    const envelope: CdpEnvelope = { id, method, params };
    if (sessionId) envelope.sessionId = sessionId;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        method,
      });

      this.ws!.send(JSON.stringify(envelope), (err) => {
        if (err && this.pending.delete(id)) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /**
   * Best-effort send that ignores its result. For acks / cleanup commands
   * where the caller doesn't care if the peer is already gone. Inspired by
   * Playwright's `_sendMayFail` (used for `Page.screencastFrameAck`).
   *
   * IMPORTANT: this MUST stay synchronous-with-respect-to-ordering — the
   * screencast ack flow stalls if acks land out of order with frame events.
   */
  sendMayFail(method: string, params: Record<string, unknown> = {}, sessionId?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const id = this.nextId++;
    const envelope: CdpEnvelope = { id, method, params };
    if (sessionId) envelope.sessionId = sessionId;
    try {
      // No pending entry, no promise — we discard the response by id mismatch.
      this.ws.send(JSON.stringify(envelope));
    } catch {
      // ignore — peer can be gone
    }
  }

  on(handler: EventListener): () => void {
    this.eventListeners.add(handler);
    return () => this.eventListeners.delete(handler);
  }

  onClose(handler: CloseListener): () => void {
    this.closeListeners.add(handler);
    return () => this.closeListeners.delete(handler);
  }

  /** Has the underlying WS been closed (by either side)? */
  isClosed(): boolean {
    return this.closed || this.ws === null || this.ws.readyState !== WebSocket.OPEN;
  }

  /** Initiate close. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.ws?.close(); } catch {}
  }

  private handleMessage(data: WebSocket.RawData): void {
    let msg: CdpEnvelope;
    try {
      msg = JSON.parse(data.toString("utf8")) as CdpEnvelope;
    } catch {
      return;
    }

    // Response to a previous send (must have an id).
    if (typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (!pending) return; // sendMayFail leaves no entry — discard
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new CdpError(msg.error.code, msg.error.message));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // CDP event.
    if (msg.method) {
      const event: CdpEvent = {
        method: msg.method,
        sessionId: msg.sessionId,
        params: (msg.params ?? {}) as Record<string, unknown>,
      };
      for (const l of this.eventListeners) {
        try {
          l(event);
        } catch {
          // listener exceptions don't kill the loop
        }
      }
    }
  }

  private handleClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    // Reject every outstanding command.
    const err = new Error(`CDP connection closed (${code}${reason ? `: ${reason}` : ""})`);
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    for (const l of this.closeListeners) {
      try {
        l({ code, reason });
      } catch {
        // swallow
      }
    }
    this.ws = null;
  }

  private handleError(_err: Error): void {
    // Errors are surfaced through the close event that follows. We could
    // stash for debugging if needed — not required for the spec's behavior.
  }
}
