import { withTimeout } from "../core/profile/cdp-utils.js";
import { InternalIdSpace } from "./id-space.js";
import { SessionStateImpl } from "./session-state.js";
import { listen } from "./socket-io.js";
import type {
  CdpMessage,
  CdpPlugin,
  PipelineCounters,
  PipelineLogEvent,
  PipelineOptions,
  PipelineResult,
} from "./types.js";

const DEFAULT_ON_SESSION_END_TIMEOUT_MS = 15_000;
const DEFAULT_DROP_THRESHOLD_BYTES = 1_000_000;

/** Minimal WebSocket contract the pipeline needs. Both `ws` (Node) and CF
 *  Workers `WebSocket` conform. Node's `ws` uses `on`, browser/Workers use
 *  `addEventListener` — we support both by feature-detecting. */
export interface PipelineSocket {
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (ev: unknown) => void): void;
  on?(event: string, listener: (data: unknown) => void): void;
  readonly bufferedAmount?: number;
}

/** Outcome of {@link Pipeline.start}. */
export type PipelineStartResult =
  | { ok: true }
  | { ok: false; plugin: string; error?: unknown };

/** CDP-aware bidirectional relay. Two-phase lifecycle:
 *  1. {@link Pipeline.start} — attaches the upstream side, runs every
 *     plugin's `onSessionStart`. Fails fast if any plugin errors; the
 *     upstream is closed and no `onSessionEnd` runs. Callers use this to
 *     probe whether the provider can serve the session before committing
 *     to a client upgrade — enables failover.
 *  2. {@link Pipeline.run} — attaches the client (or runs solo), pumps
 *     bytes, runs `onSessionEnd` for every plugin on close. */
export class Pipeline {
  private client: PipelineSocket | null = null;
  private readonly upstream: PipelineSocket;
  private readonly plugins: readonly CdpPlugin[];
  private readonly logger: (event: PipelineLogEvent) => void;
  private readonly onSessionEndTimeoutMs: number;
  private readonly dropThresholdBytes: number;
  private readonly maxSessionMs?: number;
  private readonly idleTimeoutMs?: number;

  private readonly ids = new InternalIdSpace();
  private readonly state: SessionStateImpl;
  private readonly counters: PipelineCounters = {
    bytesIn: 0,
    bytesOut: 0,
    messageCount: 0,
    parsedCount: 0,
    droppedByPlugin: 0,
    injectedCount: 0,
  };
  private started = false;
  private closed = false;
  private lastClientActivityAt = Date.now();
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private resolveResult: ((r: PipelineResult) => void) | null = null;

  constructor(
    upstream: PipelineSocket,
    upstreamUrl: string,
    opts: PipelineOptions,
  ) {
    this.upstream = upstream;
    this.plugins = opts.plugins;
    this.logger = opts.logger ?? (() => {});
    this.onSessionEndTimeoutMs = opts.onSessionEndTimeoutMs ?? DEFAULT_ON_SESSION_END_TIMEOUT_MS;
    this.dropThresholdBytes = opts.dropThresholdBytes ?? DEFAULT_DROP_THRESHOLD_BYTES;
    this.maxSessionMs = opts.maxSessionMs;
    this.idleTimeoutMs = opts.idleTimeoutMs;

    this.state = new SessionStateImpl(upstreamUrl);
    this.state.sendInternal = <T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> => {
      const { id, promise } = this.ids.allocate();
      const msg: CdpMessage = sessionId ? { id, method, params, sessionId } : { id, method, params };
      this.counters.injectedCount++;
      try {
        this.upstream.send(JSON.stringify(msg));
      } catch (err) {
        this.ids.settle(id, { error: { code: -1, message: err instanceof Error ? err.message : String(err) } });
      }
      return promise as Promise<T>;
    };
    this.state.sendInternalOneWay = (method, params, sessionId) => {
      const id = this.ids.allocate().id;
      this.ids.settle(id, { result: {} });
      const msg: CdpMessage = sessionId ? { id, method, params, sessionId } : { id, method, params };
      this.counters.injectedCount++;
      try {
        this.upstream.send(JSON.stringify(msg));
      } catch {
        /* ignore — fire-and-forget */
      }
    };
    this.state.close = (reason: string) => this.finalize(reason);
  }

  /** Phase 1. Attaches upstream listeners and runs plugin `onSessionStart`
   *  in order. On any plugin throw, closes the upstream and returns
   *  `{ok:false, plugin}`. `onSessionEnd` does NOT run on start failure. */
  async start(): Promise<PipelineStartResult> {
    if (this.started) throw new Error("Pipeline.start() called twice");
    this.started = true;
    this.attachUpstreamListeners();

    for (const p of this.plugins) {
      if (!p.onSessionStart) continue;
      try {
        await p.onSessionStart(this.state);
      } catch (err) {
        this.logger({ kind: "plugin-error", data: { plugin: p.name, hook: "onSessionStart", err: errToString(err) } });
        this.closed = true;
        try { this.upstream.close(1000); } catch { /* already closed */ }
        this.ids.rejectAll("plugin-start-failed");
        return { ok: false, plugin: p.name, error: err };
      }
      // Upstream may have closed during onSessionStart (provider dropped or
      // rejected the setup CDP calls). Treat as start failure so the caller
      // can retry with the next provider.
      if (this.closed) {
        return { ok: false, plugin: p.name, error: new Error("upstream closed during onSessionStart") };
      }
    }
    this.logger({ kind: "connect", data: { plugins: this.plugins.map((p) => p.name) } });
    return { ok: true };
  }

  /** Phase 2. Attaches the client (or null for solo mode), starts timers,
   *  awaits close, runs `onSessionEnd` for every plugin, resolves. Must
   *  be called after a successful {@link Pipeline.start}. */
  async run(client: PipelineSocket | null): Promise<PipelineResult> {
    if (!this.started) throw new Error("Pipeline.run() called before start()");
    if (this.closed) {
      return { reason: "pipeline-not-started", counters: this.counters };
    }
    this.client = client;
    if (client) this.attachClientListeners(client);
    this.startTimers();
    return new Promise<PipelineResult>((resolve) => {
      this.resolveResult = resolve;
    });
  }

  private attachUpstreamListeners(): void {
    listen(this.upstream, "message", (evt) => this.onUpstreamMessage(evt));
    listen(this.upstream, "close", () => this.finalize("upstream-closed"));
    listen(this.upstream, "error", () => this.finalize("upstream-error"));
  }

  private attachClientListeners(client: PipelineSocket): void {
    listen(client, "message", (evt) => this.onClientMessage(evt));
    listen(client, "close", () => this.finalize("client-closed"));
    listen(client, "error", () => this.finalize("client-error"));
  }

  private startTimers(): void {
    if (this.maxSessionMs && this.maxSessionMs > 0) {
      this.maxTimer = setTimeout(() => this.finalize("max-session-exceeded"), this.maxSessionMs);
    }
    if (this.idleTimeoutMs && this.idleTimeoutMs > 0) {
      const check = Math.max(1000, Math.floor(this.idleTimeoutMs / 4));
      this.idleTimer = setInterval(() => {
        if (Date.now() - this.lastClientActivityAt >= this.idleTimeoutMs!) {
          this.finalize("idle-timeout");
        }
      }, check);
    }
  }

  private onClientMessage(evt: unknown): void {
    const data = extractData(evt);
    if (data === undefined) return;
    this.lastClientActivityAt = Date.now();
    this.counters.bytesOut += byteLengthOf(data);
    this.counters.messageCount++;

    if (typeof data !== "string") {
      // Binary WS frames are never CDP; short-circuit forward.
      trySend(this.upstream, data);
      return;
    }

    const msg = tryParse(data);
    if (!msg) {
      trySend(this.upstream, data);
      return;
    }
    this.counters.parsedCount++;
    this.state.applyClientCommand(msg);

    let modified: CdpMessage | undefined | null = undefined;
    for (const p of this.plugins) {
      if (!p.onCommand) continue;
      let result: CdpMessage | null | undefined | void;
      try {
        result = p.onCommand(modified ?? msg, this.state);
      } catch (err) {
        this.logger({ kind: "plugin-error", data: { plugin: p.name, hook: "onCommand", err: errToString(err) } });
        continue;
      }
      if (result === null) {
        this.counters.droppedByPlugin++;
        return;
      }
      if (result && typeof result === "object") modified = result;
    }
    trySend(this.upstream, modified ? JSON.stringify(modified) : data);
  }

  private onUpstreamMessage(evt: unknown): void {
    const data = extractData(evt);
    if (data === undefined) return;
    this.counters.bytesIn += byteLengthOf(data);
    this.counters.messageCount++;

    if (typeof data !== "string") {
      if (this.client) trySend(this.client, data);
      return;
    }

    // Backpressure: drop upstream frames when the client can't keep up.
    // Solo mode (no client) skips this — plugins pace themselves.
    if (this.client) {
      const buffered = this.client.bufferedAmount ?? 0;
      if (buffered > this.dropThresholdBytes) {
        return;
      }
    }

    const msg = tryParse(data);
    if (!msg) {
      if (this.client) trySend(this.client, data);
      return;
    }
    this.counters.parsedCount++;

    // Response path: filter internal responses out of the client stream.
    if (typeof msg.id === "number") {
      if (this.ids.owns(msg.id)) {
        this.ids.settle(msg.id, msg);
        return;
      }
      for (const p of this.plugins) {
        if (!p.onResponse) continue;
        try {
          p.onResponse(msg, this.state);
        } catch (err) {
          this.logger({ kind: "plugin-error", data: { plugin: p.name, hook: "onResponse", err: errToString(err) } });
        }
      }
      if (this.client) trySend(this.client, data);
      return;
    }

    // Event path.
    this.state.applyUpstreamEvent(msg);
    for (const p of this.plugins) {
      if (!p.onEvent) continue;
      let result: void | null | undefined;
      try {
        result = p.onEvent(msg, this.state);
      } catch (err) {
        this.logger({ kind: "plugin-error", data: { plugin: p.name, hook: "onEvent", err: errToString(err) } });
        continue;
      }
      if (result === null) {
        this.counters.droppedByPlugin++;
        return;
      }
    }
    if (this.client) trySend(this.client, data);
  }

  private finalize(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.maxTimer) clearTimeout(this.maxTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    void this.runOnSessionEnd(reason).finally(() => {
      this.ids.rejectAll(reason);
      if (this.client) {
        try { this.client.close(1000); } catch { /* already closed */ }
      }
      try { this.upstream.close(1000); } catch { /* already closed */ }
      this.logger({ kind: "close", data: { reason, counters: this.counters } });
      this.resolveResult?.({ reason, counters: this.counters });
    });
  }

  private async runOnSessionEnd(reason: string): Promise<void> {
    for (const p of this.plugins) {
      if (!p.onSessionEnd) continue;
      try {
        await withTimeout(p.onSessionEnd(this.state, reason), this.onSessionEndTimeoutMs, `onSessionEnd/${p.name}`);
      } catch (err) {
        this.logger({ kind: "plugin-error", data: { plugin: p.name, hook: "onSessionEnd", err: errToString(err) } });
      }
    }
  }
}

function extractData(evt: unknown): string | ArrayBuffer | ArrayBufferView | undefined {
  if (evt === null || evt === undefined) return undefined;
  if (typeof evt === "string") return evt;
  if (evt instanceof ArrayBuffer) return evt;
  if (ArrayBuffer.isView(evt)) return evt;
  const asEvent = evt as { data?: unknown };
  if (asEvent && "data" in asEvent) {
    const d = asEvent.data;
    if (typeof d === "string" || d instanceof ArrayBuffer || ArrayBuffer.isView(d)) return d;
    if (d && typeof d === "object" && "buffer" in d && (d as { buffer?: unknown }).buffer instanceof ArrayBuffer) {
      return d as ArrayBufferView;
    }
    if (typeof (d as { toString?: () => string })?.toString === "function") {
      return String(d);
    }
  }
  return undefined;
}

function tryParse(text: string): CdpMessage | null {
  if (text.length === 0 || text.charCodeAt(0) !== 123) return null;
  try {
    return JSON.parse(text) as CdpMessage;
  } catch {
    return null;
  }
}

function trySend(sock: PipelineSocket, data: string | ArrayBuffer | ArrayBufferView): void {
  try {
    sock.send(data);
  } catch { /* peer probably closed; finalize will fire from the close event */ }
}

function byteLengthOf(data: string | ArrayBuffer | ArrayBufferView): number {
  if (typeof data === "string") return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.byteLength;
}

function errToString(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}

