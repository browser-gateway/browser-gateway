/** CDP-aware pipeline: shared type contracts. */

/** A single Chrome DevTools Protocol wire frame — either a command
 *  (client → upstream), a response (upstream → client, has `id`), or an
 *  event (upstream → client, has `method` but no `id`). Fields are optional
 *  because each shape uses a subset. */
export interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Metadata about a CDP target the pipeline is aware of. */
export interface TargetInfo {
  targetId: string;
  type: "page" | "iframe" | "worker" | "browser" | "other";
  url?: string;
}

/** Per-session state exposed to plugins. Read-only from the plugin's view;
 *  the pipeline mutates it as CDP framework messages flow through. */
export interface SessionState {
  /** Provider CDP WebSocket URL the pipeline bridges to. */
  readonly upstreamUrl: string;
  /** Map of CDP sessionId → attached target. Populated on
   *  `Target.attachedToTarget`, cleared on `Target.detachedFromTarget`. */
  readonly targets: ReadonlyMap<string, TargetInfo>;
  /** Send an internal command upstream (with a pipeline-owned ID) and
   *  await the matching response. Response is filtered from the
   *  client-facing stream automatically. */
  sendInternal<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  /** Fire-and-forget internal command. No response tracked. */
  sendInternalOneWay(method: string, params?: Record<string, unknown>, sessionId?: string): void;
  /** Trigger pipeline finalization from within a plugin. Idempotent — a
   *  second call is a no-op. `onSessionEnd` still runs for every plugin,
   *  including the caller. Safe to call from any hook. */
  close(reason: string): void;
}

/** A pipeline plugin. Plugins observe the CDP wire, inject their own
 *  commands, and optionally drop or rewrite client commands / upstream
 *  events. Hot-path methods (`onCommand`, `onResponse`, `onEvent`) are
 *  SYNC-ONLY — do not return promises. Lifecycle hooks
 *  (`onSessionStart`, `onSessionEnd`) are async.
 *
 *  All plugin method throws are caught and logged; a misbehaving plugin
 *  never kills the session. */
export interface CdpPlugin {
  /** Stable identifier used in logs + metrics. */
  readonly name: string;
  /** Called once after the pipeline connects to upstream and before any
   *  client messages are dispatched. Await async setup here (fetch profile
   *  from R2, prime state, subscribe to a domain). */
  onSessionStart?(state: SessionState): Promise<void>;
  /** Called once before the pipeline disconnects. Await state persistence
   *  here (R2 uploads, D1 writes, profile commits). The pipeline waits up
   *  to `PipelineOptions.onSessionEndTimeoutMs` per plugin. */
  onSessionEnd?(state: SessionState, reason: string): Promise<void>;
  /** Client → upstream command. Return `null` to drop, a `CdpMessage` to
   *  rewrite, or `undefined` (implicit) to forward as-is. MUST NOT return
   *  a Promise — enforced by type. Fire async work via `void asyncFn()`. */
  onCommand?(msg: CdpMessage, state: SessionState): CdpMessage | null | undefined | void;
  /** Upstream → client response to a client command. Passive observation
   *  only in v0.1. SYNC. */
  onResponse?(msg: CdpMessage, state: SessionState): void;
  /** Upstream → client event. Return `null` to drop, `void`/`undefined`
   *  to forward. SYNC. */
  onEvent?(msg: CdpMessage, state: SessionState): void | null | undefined;
}

export interface PipelineLogEvent {
  kind: "connect" | "close" | "plugin-error" | "parse-error" | "inject-error";
  data: Record<string, unknown>;
}

export interface PipelineCounters {
  bytesIn: number;
  bytesOut: number;
  messageCount: number;
  parsedCount: number;
  droppedByPlugin: number;
  injectedCount: number;
}

export interface PipelineResult {
  reason: string;
  counters: PipelineCounters;
}

export interface PipelineOptions {
  plugins: CdpPlugin[];
  /** Optional logger. Called for lifecycle events + errors. Never throws. */
  logger?: (event: PipelineLogEvent) => void;
  /** Max ms to wait for each plugin's `onSessionEnd` before force-closing.
   *  Default 15_000. */
  onSessionEndTimeoutMs?: number;
  /** Max session wall-clock in ms. Fires a graceful close when exceeded. */
  maxSessionMs?: number;
  /** If no client activity for this many ms, close as idle. Optional. */
  idleTimeoutMs?: number;
  /** Drop upstream frames when the client socket's `bufferedAmount` exceeds
   *  this many bytes. Default 1_000_000. */
  dropThresholdBytes?: number;
  /** Called with the wallclock ms of client-side activity, throttled by
   *  `activityThrottleMs`. Fires at most once per throttle window. MUST NOT
   *  throw or block — failures are swallowed. Use to persist `last_activity_at`
   *  without polluting telemetry on idle sessions. */
  onActivity?: (activityAtMs: number) => void;
  /** Throttle window in ms for `onActivity`. Default 60_000. */
  activityThrottleMs?: number;
}
