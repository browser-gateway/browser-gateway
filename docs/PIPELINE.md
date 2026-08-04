# Pipeline + plugins

Architecture reference for the CDP-aware pipeline that shipped in 0.4.6 and finished in 0.4.8. Read this before writing a new plugin, changing the plugin lifecycle, or debugging a session that goes through `/v1/connect?profile=` or `?session_record=` or `/v1/live`.

Companions: [`HELPER-CATALOG.md`](./HELPER-CATALOG.md) for the flat inventory of every exported symbol, [`CODE-QUALITY.md`](./CODE-QUALITY.md) for the seven pre-commit gates that keep this codebase honest.

## Why the pipeline exists

Before 0.4.6 every session was a byte-pipe: bytes from the client's WebSocket got copied to the provider's WebSocket and back, with no parsing in the middle. That's ideal for pure routing — zero CPU overhead, protocol-agnostic — but any feature that needs to look at the CDP wire (profile inject, session recording, live viewer, observability) had to open a second WebSocket to the same provider, driving up cost, complexity, and latency.

The pipeline sits in the middle of one WebSocket instead:

```
   client WS  <─────────── pipeline ───────────>  upstream WS
                          │
                    ┌─────┴─────┐
                    │  plugins  │  (0..N, each sees every CDP message)
                    └───────────┘
```

Plugins observe events, filter responses, inject their own commands, and rewrite messages as they flow. One WebSocket per session, no matter how many features are on.

**Zero-regression rule**: sessions with zero plugins take the byte-pipe fast lane — no parsing, no mux overhead, identical wire behaviour to pre-0.4.6. This is enforced at the handler level in `src/server/ws/upgrade.ts` (OSS) and `apps/router/src/index.ts` (SaaS): the pipeline is only instantiated when `plugins.length > 0`. The byte-pipe path stays as `pipeBidirectional`/`NodeTcpPipeTransport`.

## Two-phase lifecycle

`Pipeline` has a deliberately split lifecycle so provider failover works cleanly:

```ts
const pipeline = new Pipeline(upstream, upstreamUrl, { plugins, ... });

const start = await pipeline.start();      // Phase 1 — upstream only, no client yet
if (!start.ok) {
  // Plugin setup failed. Client socket is UNTOUCHED. Try next provider.
  return tryNextProvider();
}

const result = await pipeline.run(client); // Phase 2 — bind client, pump bytes
```

**Phase 1 (`start`)** attaches upstream listeners and runs every plugin's `onSessionStart` in order. If any plugin throws, the upstream is closed, no `onSessionEnd` fires, and `{ ok: false, plugin }` returns. The client socket is never touched — the caller can 503, retry with a different provider, or fail fast.

**Phase 2 (`run`)** attaches the client (or `null` for solo mode, see below), starts the byte pump + idle/max timers, and resolves when the session ends. `onSessionEnd` runs for every plugin on close.

The split exists because "the profile failed to inject on provider A" is a recoverable failure — the client should silently retry against provider B. The old single-phase design would have needed to close the client socket to signal failure. Two phases keep the failover transparent.

## Plugin interface

```ts
interface CdpPlugin {
  readonly name: string;                              // for logs + metrics
  onSessionStart?(state: SessionState): Promise<void>;
  onSessionEnd?(state: SessionState, reason: string): Promise<void>;
  onCommand?(msg: CdpMessage, state: SessionState): CdpMessage | null | undefined | void;
  onResponse?(msg: CdpMessage, state: SessionState): void;
  onEvent?(msg: CdpMessage, state: SessionState): void | null | undefined;
}
```

**Async hooks** — `onSessionStart` / `onSessionEnd` — run once per session. Await here to fetch a profile from R2, prime state, subscribe to a domain, persist replay chunks, commit a captured profile back to storage. Every plugin's `onSessionEnd` gets `PipelineOptions.onSessionEndTimeoutMs` (default 15 s) before it's force-completed.

**Sync hooks** — `onCommand` / `onResponse` / `onEvent` — fire on every parsed CDP frame in the byte pump. They MUST NOT return promises; the type enforces this. If a hook needs async work, wrap it in `void asyncFn()` and let it run in the background. Any throw in a sync hook is caught, logged, and the message continues down the chain — one bad plugin never kills the session.

- `onCommand` (client → upstream): return `null` to drop the command, return a `CdpMessage` to rewrite, return `void` to forward as-is. Runs before the message hits the upstream.
- `onResponse` (upstream → client, has `id`): passive observation only in v0.1. Cannot rewrite.
- `onEvent` (upstream → client, no `id`): return `null` to hide from the client stream, `void` to forward.

Framework messages (`Target.attachedToTarget`, `Target.detachedFromTarget`) are applied to `state` *before* plugins see them, so `state.targets` is always current when a hook fires.

## SessionState

Plugins interact with the wire through `SessionState`:

```ts
interface SessionState {
  readonly upstreamUrl: string;
  readonly targets: ReadonlyMap<string, TargetInfo>;
  sendInternal<T>(method, params?, sessionId?): Promise<T>;      // awaited response
  sendInternalOneWay(method, params?, sessionId?): void;         // fire-and-forget
  close(reason: string): void;                                   // trigger finalize
}
```

`sendInternal` allocates a pipeline-owned message ID (in the reserved 2^30 range so it never collides with client IDs), sends the command upstream, and awaits the matching response. The response is *filtered out* of the client-facing stream — the client never sees plugin traffic. This is the correct way for a plugin to talk to Chrome without polluting the client's protocol view.

`sendInternalOneWay` is the same but doesn't wait; use it when you don't care about the response (e.g. `Page.screencastFrameAck`, cleanup commands during `onSessionEnd`).

`state.close(reason)` triggers `finalize` from within a plugin — used by `ScreencastBridgePlugin` when the viewer closes or the keep-alive expires. Idempotent.

## Solo mode

`pipeline.run(null)` — no client, just the pipeline talking to upstream through plugins. Used by `/v1/live`: the viewer speaks the LIVE protocol (binary frames + JSON control messages), not raw CDP, so it can't ride the pipeline as a "client" — instead, `ScreencastBridgePlugin` owns the viewer socket and forwards frames to it directly, while the pipeline handles the CDP wire on the upstream side.

Backpressure is skipped in solo mode (no client bufferedAmount to check); plugins pace themselves.

## Plugins that ship today

| Plugin | Source | Purpose |
|---|---|---|
| `ProfilePlugin` | `src/pipeline/plugins/profile.ts` | Inject profile on session start (Fetch.fulfill helper-pool); capture + persist on end. Works with any `ProfileStorage` implementation (Node fs, R2, in-memory, mock). Preloaded mode lets the caller own the lock lifecycle. |
| `ScreencastCapturePlugin` | `src/pipeline/plugins/screencast-capture.ts` | Auto-attach to every page target, `Page.startScreencast`, dedup frames by FNV-1a hash, write chunked binary parts + manifest to a `ReplayStorage`. Session-record path. |
| `ScreencastBridgePlugin` | `src/pipeline/plugins/screencast-bridge.ts` | Create `about:blank` target, stream JPEG frames to a viewer WS (any `PipelineSocket`), dispatch viewer input (mouse/key/nav/setViewport/paste/close), keep-alive timers. Playground path. |
| `ObservabilityPlugin` | `app/apps/router/src/pipeline/observability-plugin.ts` (SaaS) | Passive CDP wire-parse — captures network + console + navigation events into an R2-backed session trace. Never mutates the stream. |

Plugins compose freely. `/v1/connect?profile=X&session_record=true` runs `[ProfilePlugin, ScreencastCapturePlugin]` on the same pipeline — proven in tier-3 (`tests/oss-pipeline-0.4.8/`).

## Writing a new plugin

Minimum viable plugin:

```ts
import type { CdpPlugin, CdpMessage, SessionState } from "browser-gateway/pipeline";

export class MyPlugin implements CdpPlugin {
  readonly name = "my-plugin";

  async onSessionStart(state: SessionState): Promise<void> {
    // Optional. Fetch config, prime state, subscribe to a domain.
    // Await async work here. If you throw, this session is aborted
    // and the caller can retry with another provider.
  }

  onEvent(msg: CdpMessage, state: SessionState): void | null {
    // Sync only. Return null to drop from the client stream.
    if (msg.method === "Network.responseReceived") {
      // do something cheap
    }
  }

  async onSessionEnd(state: SessionState, reason: string): Promise<void> {
    // Optional. Persist results. You get 15 s before force-timeout.
  }
}
```

That's the whole surface. Register it in the plugin array passed to `Pipeline`:

```ts
const pipeline = new Pipeline(upstream, upstreamUrl, {
  plugins: [new MyPlugin(), ...],
  logger: (event) => { /* structured logging */ },
});
```

### Writing a plugin that talks to Chrome

Use `state.sendInternal` for any command whose response you need:

```ts
async onSessionStart(state: SessionState): Promise<void> {
  const { targetId } = await state.sendInternal<{ targetId: string }>(
    "Target.createTarget",
    { url: "about:blank" },
  );
  const { sessionId } = await state.sendInternal<{ sessionId: string }>(
    "Target.attachToTarget",
    { targetId, flatten: true },
  );
  await state.sendInternal("Page.enable", {}, sessionId);
}
```

Use `state.sendInternalOneWay` for fire-and-forget:

```ts
onEvent(msg: CdpMessage, state: SessionState) {
  if (msg.method === "Page.screencastFrame" && msg.sessionId === this.sessionId) {
    state.sendInternalOneWay("Page.screencastFrameAck",
      { sessionId: (msg.params as any).sessionId }, this.sessionId);
    return null; // don't forward the frame to the client
  }
}
```

### Writing a plugin that uses the OSS helper-pool

For profile inject / capture, don't reimplement the Fetch.fulfill pattern — use `injectStateEager` and `captureFullStateOnClient` from `browser-gateway/core` (isomorphic, Workers-safe):

```ts
import { injectStateEager, type HelperPoolCdpClient } from "browser-gateway/core";
import { PluginCdpClient } from "browser-gateway/pipeline";

async onSessionStart(state: SessionState): Promise<void> {
  const client: HelperPoolCdpClient = new PluginCdpClient(state);
  await injectStateEager(client, this.profile, { eagerOriginLimit: 20, helperPages: 4 });
}
```

`PluginCdpClient` adapts `SessionState` to the `HelperPoolCdpClient` interface (`send`/`sendOn`/`on`/`off`), so any code written against `WsCDPClient` (Node) or a fresh WS transient (Workers) works verbatim inside the pipeline.

### Custom viewer / dashboard traffic

Own the viewer socket in your plugin — don't try to route it through the pipeline as a "client":

```ts
export class MyBridgePlugin implements CdpPlugin {
  constructor(private viewer: PipelineSocket) {}

  async onSessionStart(state: SessionState) {
    // Attach message/close/error listeners on the viewer here.
    // Forward frames to the viewer directly (not via the pipeline client).
  }
}
```

Call `pipeline.run(null)` from the outer handler — the pipeline stays in solo mode and doesn't try to forward anything to a non-existent CDP client.

## Isomorphic constraint

Plugins under `src/pipeline/plugins/` MUST be isomorphic — they run in Node (OSS gateway) and Cloudflare Workers (SaaS router) with the same source. That means:

- No `node:` imports. Use `Web Crypto` instead of `node:crypto`, `Uint8Array` instead of `Buffer`.
- No `ws` package. Rely on the `PipelineSocket` interface, which both Node `ws` and Workers `WebSocket` satisfy.
- Base64 via `atob` (available in both), not `Buffer.from(b, "base64")`.

Node-specific storage adapters (e.g. `NodeReplayStorage`, `NodeProfileStorage`) live under `src/server/` and implement the isomorphic storage interface the plugin depends on. Workers-specific adapters (R2-backed) live in the SaaS.

## Hot-path gotchas

Bugs seen in the wild, encoded here so we don't repeat them:

1. **Sync hooks throwing don't kill the session, but they don't retry either.** The message is dropped from that plugin's processing and continues to the next plugin. If your plugin's state gets corrupted mid-session, catch and reset explicitly.
2. **`onSessionStart` throws are terminal for the session.** No fallback, no partial state — the upstream closes, the pipeline returns `{ ok: false, plugin }`, the caller must retry with another provider. Design async setup to succeed or fail cleanly.
3. **Upstream can close mid-`onSessionStart`.** The pipeline checks `closed` between plugins and returns `{ ok:false, plugin, error: "upstream closed during onSessionStart" }` if it does. Your plugin's `onSessionStart` MAY be interrupted between awaits — clean up any resources you allocated.
4. **`onSessionEnd` has a 15 s timeout.** Long-running finalize (chunk flush, R2 upload, DB write) is fine up to that budget; past it, you're force-completed and any in-flight work is orphaned. Design finalize to be interruptible.
5. **`Page.startScreencast` needs `Page.setDeviceMetricsOverride` first.** Chromium bug ([`puppeteer/puppeteer#10527`](https://github.com/puppeteer/puppeteer/issues/10527)). Both screencast plugins send `Page.setDeviceMetricsOverride` before `Page.startScreencast`. Cost us 0.4.7 tier-3 hours; documented in-line.
6. **`about:blank` doesn't emit frames.** Chrome only emits screencast frames when there's content to render. Viewer sessions that don't navigate anywhere never see a frame. `ScreencastBridgePlugin` is fine with this because the viewer sends a `navigate` control message when the user types a URL; automated tests need to send navigate proactively.
7. **Client backpressure at 1 MB `bufferedAmount`.** Upstream frames beyond that threshold are dropped (`counters.droppedByPlugin++`). Solo mode skips this — no client.
8. **`nodejs_compat` is required in `wrangler.toml`.** Because ProfilePlugin transitively imports some Node-only files (encryption path, unused in Workers but pulled by the barrel export). Polyfilled by wrangler at zero cost, but the flag must be on.

## Where the pipeline runs

- **OSS `/v1/connect`** — `src/server/ws/pipeline-relay.ts` handles the two-phase Pipeline for any session with plugins. Byte-pipe fast lane in `src/server/ws/upgrade.ts` `pipeToProvider()` for zero-plugin sessions.
- **OSS `/v1/live`** — `src/server/live/upgrade.ts` runs Pipeline in solo mode (`client=null`) with `ScreencastBridgePlugin` + optional `ProfilePlugin(preloaded)`.
- **SaaS `/v1/connect`** — `apps/router/src/pipeline/run.ts` wraps Pipeline; called from `apps/router/src/index.ts` with `[ObservabilityPlugin?, ProfilePlugin?]`. Byte-pipe fast lane preserved.
- **SaaS `/v1/live`** — currently uses `LiveRelayDO` + a bespoke transient-WS profile inject (`apps/router/src/profile/transient-inject.ts`) via the OSS `injectStateEager` helper. Not yet migrated to Pipeline+ScreencastBridgePlugin; queued as a future optimization.

## Test coverage

- **Tier-1 unit** — `browser-gateway/tests/pipeline/*.test.ts` and `browser-gateway/tests/core/profile/*` cover the Pipeline mux, InternalIdSpace, SessionState, and each plugin's isolated behaviour with mock upstream + client.
- **Tier-2 integration** — `browser-gateway/tests/integration/profile-*.test.ts`, `browser-gateway/tests/integration/replay-*.test.ts` cover the real Chrome + real WebSocket paths inside CI.
- **Tier-3 infrastructure** — `tests/oss-pipeline-0.4.8/golden.mjs` (12/12 PASS as of 2026-08-04) runs six real-user scenarios against Railway browserless + browserserve. The upcoming durable E2E workflow suite (`planning/testing/e2e-workflow-suite-2026-08-04.md`) replaces this per-release tier-3 with a stable, user-perspective suite.

## Adding a plugin to the catalog

`docs/HELPER-CATALOG.md` is auto-generated from every exported symbol. When you add a new plugin:

1. Export it from `src/pipeline/index.ts` (add both the class and its opts type).
2. Run `npm run catalog:gen` — updates the catalog file.
3. The pre-commit hook `catalog:check` will fail otherwise.
4. Public API changes get reviewed via `api:check` — commit the updated `docs/api/*.api.md` alongside your source change.

## Version history

- **0.4.6** — Pipeline foundation shipped. `Pipeline` class, `CdpPlugin` interface, `InternalIdSpace`, `SessionStateImpl`. SaaS `ObservabilityPlugin` was the first consumer.
- **0.4.7** — `ScreencastCapturePlugin` shipped. OSS `/v1/connect?session_record=true` routes through the pipeline. `WsCDPClient.sendOn` gained a per-command timeout (fixed a 0.4.6 hang).
- **0.4.8** — Two-phase lifecycle (`start` + `run`), `ProfilePlugin` with preloaded mode, `ScreencastBridgePlugin`, OSS `/v1/live` migrated, SaaS profile handler migrated. Legacy code retired: `ReplayController`, `ReplayCapture`, `src/server/live/screencast-bridge.ts`, `src/server/live/cdp-client.ts`. Net −2000 LOC.
