/** Pure CDP protocol layer — request/response matching + event emission over a pluggable transport. Isomorphic. */

export interface CdpTransport {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (reason?: string) => void): void;
  close(): Promise<void>;
}

import { type PendingCall, dispatchCdpResponse } from "./dispatch.js";

export interface CdpEnvelope {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  sessionId?: string;
}

export interface CdpEventMessage {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export type CdpIncoming = CdpResponse | CdpEventMessage;

/** Serialize a command envelope for the wire. */
export function encodeCommand(env: CdpEnvelope): string {
  const out: Record<string, unknown> = {
    id: env.id,
    method: env.method,
    params: env.params ?? {},
  };
  if (env.sessionId) out.sessionId = env.sessionId;
  return JSON.stringify(out);
}

/** Parse an incoming CDP frame. Returns null when the payload isn't valid JSON. */
export function decodeIncoming(data: string): CdpIncoming | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id === "number") return obj as unknown as CdpResponse;
  if (typeof obj.method === "string") return obj as unknown as CdpEventMessage;
  return null;
}

/** CDP protocol client. Composes a transport with call/response matching + event dispatch.
 *  Same behavioural contract as the OSS `WsCDPClient` but transport-agnostic. */
export class CdpProtocolClient {
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private eventHandlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private closed = false;

  constructor(private transport: CdpTransport) {
    transport.onMessage((data) => this.handleMessage(data));
    transport.onClose((reason) => this.handleClose(reason));
  }

  /** Send a CDP command. Pass a `sessionId` to route to a specific attached target
   *  (flat-mode CDP); pass undefined for the browser-level session. Cloud consumers
   *  typically define their own `send()` sugar as `sendOn(m, p, undefined)`. */
  async sendOn(
    method: string,
    params: Record<string, unknown> = {},
    sessionId: string | undefined,
  ): Promise<unknown> {
    if (this.closed) throw new Error("CDP transport is closed");
    const id = this.nextId++;
    const frame = encodeCommand({ id, method, params, sessionId });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.transport.send(frame);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  on(event: string, handler: (params: Record<string, unknown>) => void): void {
    let set = this.eventHandlers.get(event);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(event, set);
    }
    set.add(handler);
  }

  off(event: string, handler: (params: Record<string, unknown>) => void): void {
    const set = this.eventHandlers.get(event);
    if (set) set.delete(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.transport.close();
    this.rejectAllPending(new Error("CDP transport closed by caller"));
  }

  private handleMessage(data: string): void {
    const msg = decodeIncoming(data);
    if (!msg) return;
    if (dispatchCdpResponse(msg as { id?: unknown; error?: { message: string }; result?: unknown }, this.pending)) return;
    if (!("method" in msg)) return;
    const handlers = this.eventHandlers.get(msg.method);
    if (!handlers || handlers.size === 0) return;
    const params: Record<string, unknown> = { ...(msg.params ?? {}) };
    if (msg.sessionId) params.__sessionId = msg.sessionId;
    for (const h of handlers) h(params);
  }

  private handleClose(reason?: string): void {
    this.closed = true;
    this.rejectAllPending(new Error(reason ?? "CDP transport closed by peer"));
  }

  private rejectAllPending(err: Error): void {
    for (const call of this.pending.values()) call.reject(err);
    this.pending.clear();
  }
}
