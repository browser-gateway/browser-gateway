import type { HelperPoolCdpClient } from "../../core/profile/helper-pool-client.js";
import type { CdpMessage, SessionState } from "../types.js";

type Handler = (params: unknown) => void;

/** Bridges the pipeline's SessionState to the HelperPoolCdpClient interface
 *  that profile inject/capture and helper-pool code expect. Commands go out
 *  via `state.sendInternal` (rides the client's own CDP connection — no
 *  second WS). Events are forwarded from the plugin's `onEvent` hook via
 *  {@link dispatchEvent}. */
export class PluginCdpClient implements HelperPoolCdpClient {
  private readonly handlers = new Map<string, Set<Handler>>();

  constructor(private readonly state: SessionState) {}

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.state.sendInternal<T>(method, params);
  }

  async sendOn<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    return this.state.sendInternal<T>(method, params, sessionId);
  }

  on(method: string, handler: Handler): void {
    const set = this.handlers.get(method) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(method, set);
  }

  off(method: string, handler: Handler): void {
    this.handlers.get(method)?.delete(handler);
  }

  /** Route a CDP event received via the pipeline plugin's `onEvent` hook
   *  to any registered handlers. The `__sessionId` magic key preserved from
   *  `WsCDPClient` behavior lets helper-pool code filter by target. */
  dispatchEvent(msg: CdpMessage): void {
    if (!msg.method) return;
    const handlers = this.handlers.get(msg.method);
    if (!handlers || handlers.size === 0) return;
    const params: Record<string, unknown> = { ...(msg.params ?? {}) };
    if (msg.sessionId) params.__sessionId = msg.sessionId;
    for (const h of handlers) {
      try { h(params); } catch { /* isolate handlers from each other */ }
    }
  }

  /** Registered method names (test hook). */
  registeredMethods(): string[] {
    return Array.from(this.handlers.keys());
  }
}
