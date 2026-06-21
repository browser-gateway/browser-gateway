import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { CDPClient } from "./cdp.js";

interface CDPMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/**
 * Minimal raw-CDP client over a single WebSocket.
 *
 * - Browser-level only: no Target.attachToTarget by default.
 * - Suitable for Storage.* commands (browser-wide cookies, etc.) without a target.
 * - Tests use the existing EventEmitter-based MockCDP; production uses this.
 */
export class WsCDPClient extends EventEmitter implements CDPClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private closeError: Error | null = null;

  on(event: string, listener: (params: unknown) => void): this {
    return super.on(event, listener);
  }
  off(event: string, listener: (params: unknown) => void): this {
    return super.off(event, listener);
  }

  async connect(wsUrl: string, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      let resolved = false;
      const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        try { ws.close(); } catch {}
        reject(new Error(`CDP connect timeout after ${timeoutMs}ms: ${wsUrl}`));
      }, timeoutMs);

      ws.once("open", () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        this.ws = ws;
        ws.on("message", (data) => this.handleMessage(data as Buffer));
        ws.on("close", (code, reason) => this.handleClose(code, reason.toString("utf8")));
        ws.on("error", (err) => {
          this.closeError = err;
        });
        resolve();
      });

      ws.once("error", (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP not connected");
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async close(): Promise<void> {
    if (!this.ws) return;
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2_000);
        this.ws!.once("close", () => {
          clearTimeout(t);
          resolve();
        });
        try { this.ws!.close(); } catch {}
      });
    }
    this.ws = null;
  }

  private handleMessage(data: Buffer): void {
    let msg: CDPMessage;
    try {
      msg = JSON.parse(data.toString("utf8")) as CDPMessage;
    } catch {
      return;
    }

    if (typeof msg.id === "number") {
      const call = this.pending.get(msg.id);
      if (!call) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        call.reject(new Error(`CDP error: ${msg.error.message}`));
      } else {
        call.resolve(msg.result ?? null);
      }
      return;
    }

    if (typeof msg.method === "string") {
      this.emit(msg.method, msg.params);
    }
  }

  private handleClose(code: number, reason: string): void {
    const err = this.closeError ?? new Error(`CDP connection closed (code=${code}${reason ? `, reason=${reason}` : ""})`);
    for (const call of this.pending.values()) {
      call.reject(err);
    }
    this.pending.clear();
  }
}
