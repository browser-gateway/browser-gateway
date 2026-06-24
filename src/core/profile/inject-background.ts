import { WsCDPClient } from "./cdp-client.js";
import {
  closeHelperPages,
  installFetchFulfill,
  navigateAndEvaluate,
  openHelperPool,
  runHelperPool,
} from "./helper-pool.js";
import { buildLocalStorageWriteExpression } from "./inject-eager.js";
import type { OriginStorage, SkippedOrigin } from "./types.js";

interface BackgroundCommonOptions {
  /** Origins still to inject (from the eager-phase deferred list). */
  origins: string[];
  /** Origin → localStorage data from the profile. */
  storage: Record<string, OriginStorage>;
  /** Shared with lazy hydration to prevent double-injection. */
  alreadyInjected: Set<string>;
  /** Number of helper pages. Default 2 (lower than eager so it doesn't crowd the user). */
  helperPages?: number;
  /** Per-origin timeout. Default 5_000. */
  perOriginTimeoutMs?: number;
  /**
   * Delay before opening the background WS, in ms. Default 0. Some hosted
   * providers cap concurrent WS connections per session token and reject the
   * second one with a 502 if it opens before the eager-phase WS is fully
   * torn down server-side. A short delay gives that teardown time to complete.
   * Not applied when using `runBackgroundInjectOnClient` (the client is already
   * connected — sharing makes the delay unnecessary).
   */
  startDelayMs?: number;
  /** Optional callback when an origin is injected (useful for telemetry). */
  onInjected?: (origin: string) => void;
  /** Optional callback when an origin fails. */
  onError?: (origin: string, reason: string) => void;
  /** AbortSignal. */
  signal?: AbortSignal;
}

export interface BackgroundInjectOptions extends BackgroundCommonOptions {
  /** Provider WS URL. */
  providerWsUrl: string;
  /** Total budget (ms). Default 60_000. */
  totalTimeoutMs?: number;
}

export interface BackgroundInjectResult {
  injected: string[];
  skipped: SkippedOrigin[];
  durationMs: number;
}

/** Runs the background phase on an already-connected client. Caller owns the WS lifecycle. */
export async function runBackgroundInjectOnClient(
  client: WsCDPClient,
  opts: BackgroundCommonOptions,
): Promise<BackgroundInjectResult> {
  const started = Date.now();
  const helperCount = Math.max(1, opts.helperPages ?? 2);
  const perOriginTimeout = opts.perOriginTimeoutMs ?? 5_000;

  const injected: string[] = [];
  const skipped: SkippedOrigin[] = [];

  const queue = opts.origins.filter((origin) => {
    if (opts.alreadyInjected.has(origin)) return false;
    const data = opts.storage[origin];
    return data && Object.keys(data.localStorage ?? {}).length > 0;
  });

  if (queue.length === 0) {
    return { injected, skipped, durationMs: Date.now() - started };
  }

  let detachFulfill: (() => void) | null = null;
  const helperSessionIds = new Set<string>();
  let helpers: { targetId: string; sessionId: string }[] = [];

  try {
    detachFulfill = installFetchFulfill(client, helperSessionIds);
    helpers = await openHelperPool(client, Math.min(helperCount, queue.length));
    for (const h of helpers) helperSessionIds.add(h.sessionId);

    const targetOrigins = queue.filter((o) => {
      if (opts.alreadyInjected.has(o)) return false;
      opts.alreadyInjected.add(o);
      return true;
    });

    await runHelperPool({
      helpers,
      origins: targetOrigins,
      signal: opts.signal,
      work: (origin, helper) =>
        navigateAndEvaluate(
          client,
          helper,
          origin,
          buildLocalStorageWriteExpression(opts.storage[origin]),
          perOriginTimeout,
        ),
      onSuccess: (origin) => {
        injected.push(origin);
        opts.onInjected?.(origin);
      },
      onError: (origin, reason) => {
        skipped.push({ origin, reason });
        opts.onError?.(origin, reason);
      },
    });
  } finally {
    if (detachFulfill) detachFulfill();
    await closeHelperPages(client, helpers);
  }

  return { injected, skipped, durationMs: Date.now() - started };
}

/** Opens its own WS to the provider, runs the background phase, then closes the WS. */
export async function runBackgroundInject(
  opts: BackgroundInjectOptions,
): Promise<BackgroundInjectResult> {
  const started = Date.now();
  const totalTimeout = opts.totalTimeoutMs ?? 60_000;

  if (opts.startDelayMs && opts.startDelayMs > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        opts.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, opts.startDelayMs);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (opts.signal?.aborted) {
      return { injected: [], skipped: [], durationMs: Date.now() - started };
    }
  }

  const client = new WsCDPClient();
  try {
    await client.connect(opts.providerWsUrl, totalTimeout);
    return await runBackgroundInjectOnClient(client, opts);
  } finally {
    await client.close().catch(() => undefined);
  }
}

