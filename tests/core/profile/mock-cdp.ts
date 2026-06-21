import { EventEmitter } from "node:events";
import type { CDPClient } from "../../../src/core/profile/cdp.js";

export type Handler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

export interface CallRecord {
  method: string;
  params: Record<string, unknown>;
}

export class MockCDP extends EventEmitter implements CDPClient {
  public readonly calls: CallRecord[] = [];
  private readonly handlers = new Map<string, Handler>();
  /** When set, every call to send() resolves after this delay (ms). */
  public sendDelayMs = 0;
  /** When set, fires Page.loadEventFired this many ms after each Page.navigate. */
  public autoFireLoadAfterMs: number | null = 0;

  on(event: string, listener: (params: unknown) => void): this {
    return super.on(event, listener);
  }
  off(event: string, listener: (params: unknown) => void): this {
    return super.off(event, listener);
  }

  setHandler(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  setResponse(method: string, value: unknown): void {
    this.handlers.set(method, () => value);
  }

  setError(method: string, error: Error): void {
    this.handlers.set(method, () => Promise.reject(error));
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const p = params ?? {};
    this.calls.push({ method, params: p });
    if (this.sendDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.sendDelayMs));
    }
    const handler = this.handlers.get(method);
    if (method === "Page.navigate" && this.autoFireLoadAfterMs !== null) {
      const after = this.autoFireLoadAfterMs;
      setTimeout(() => this.emit("Page.loadEventFired", {}), after);
    }
    if (handler) {
      return handler(p);
    }
    // Sensible defaults so untested methods don't blow up.
    if (method === "Network.getAllCookies") return { cookies: [] };
    if (method === "Page.navigate") return {};
    if (method === "Page.enable" || method === "Network.enable") return {};
    if (method === "Network.setCookies") return {};
    return {};
  }

  callsForMethod(method: string): CallRecord[] {
    return this.calls.filter((c) => c.method === method);
  }

  reset(): void {
    this.calls.length = 0;
    this.handlers.clear();
    this.removeAllListeners();
    this.autoFireLoadAfterMs = 0;
  }
}
