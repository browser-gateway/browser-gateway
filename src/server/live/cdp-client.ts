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

  /** Opens the WS to `wsUrl`. Rejects on connect failure or timeout. */
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

  /** Sends a CDP command. Resolves with `result`. Rejects with `CdpError` on peer error. */
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

  /** Fire-and-forget send. Used for screencast acks and cleanup commands. */
  sendMayFail(method: string, params: Record<string, unknown> = {}, sessionId?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const id = this.nextId++;
    const envelope: CdpEnvelope = { id, method, params };
    if (sessionId) envelope.sessionId = sessionId;
    try {
      this.ws.send(JSON.stringify(envelope));
    } catch {
      // ignore
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

  /** Returns true once the underlying WS is closed by either side. */
  isClosed(): boolean {
    return this.closed || this.ws === null || this.ws.readyState !== WebSocket.OPEN;
  }

  /** Idempotently initiates close. */
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

    if (typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new CdpError(msg.error.code, msg.error.message));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

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
          // ignore
        }
      }
    }
  }

  private handleClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error(`CDP connection closed (${code}${reason ? `: ${reason}` : ""})`);
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    for (const l of this.closeListeners) {
      try {
        l({ code, reason });
      } catch {
        // ignore
      }
    }
    this.ws = null;
  }

  private handleError(_err: Error): void {
    // surfaced via close event
  }
}
