/**
 * Background origin loader — phase B of the hybrid restore strategy.
 *
 * After the eager phase finishes (phase A: top-K injected synchronously),
 * the remaining "cold" origins are NOT pre-loaded. The user's session is
 * already usable. This module spins up helper pages in parallel and chews
 * through the deferred origins INVISIBLY in the background, so that within
 * ~30 seconds of session start every origin in the profile is warm.
 *
 * Coordination with lazy hydration:
 *   - A shared `alreadyInjected` Set guards against double-injection.
 *   - If the user navigates to a cold origin while this loader hasn't reached
 *     it yet, the lazy listener wins (Set.add is atomic in single-threaded JS).
 *   - If the loader gets there first, the lazy listener's `has(origin)` check
 *     short-circuits.
 *
 * Resource awareness:
 *   - Bounded by the helper-page count we open (default 2 to leave headroom
 *     for the user's foreground work).
 *   - Respects abort signal — closes helpers + WS immediately.
 *   - Errors per-origin are recorded but don't abort the whole background pass.
 */
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

export interface BackgroundInjectOptions {
  /** Origins still to inject (from the eager-phase deferred list). */
  origins: string[];
  /** Origin → localStorage data from the profile. */
  storage: Record<string, OriginStorage>;
  /** Provider WS URL. */
  providerWsUrl: string;
  /** Shared with lazy hydration to prevent double-injection. */
  alreadyInjected: Set<string>;
  /** Number of helper pages. Default 2 (lower than eager so it doesn't crowd the user). */
  helperPages?: number;
  /** Per-origin timeout. Default 5_000. */
  perOriginTimeoutMs?: number;
  /** Total budget (ms). Default 60_000. */
  totalTimeoutMs?: number;
  /** Optional callback when an origin is injected (useful for telemetry). */
  onInjected?: (origin: string) => void;
  /** Optional callback when an origin fails. */
  onError?: (origin: string, reason: string) => void;
  /** AbortSignal. */
  signal?: AbortSignal;
}

export interface BackgroundInjectResult {
  injected: string[];
  skipped: SkippedOrigin[];
  durationMs: number;
}

/**
 * Run the background phase. Returns when ALL deferred origins are either
 * injected or skipped (or abort fires). Designed to be invoked with `void`
 * — the caller doesn't await it; the session is already usable.
 */
export async function runBackgroundInject(
  opts: BackgroundInjectOptions,
): Promise<BackgroundInjectResult> {
  const started = Date.now();
  const helperCount = Math.max(1, opts.helperPages ?? 2);
  const perOriginTimeout = opts.perOriginTimeoutMs ?? 5_000;
  const totalTimeout = opts.totalTimeoutMs ?? 60_000;

  const injected: string[] = [];
  const skipped: SkippedOrigin[] = [];

  // Pre-filter: skip origins that are already injected (eager or lazy) OR
  // have empty storage.
  const queue = opts.origins.filter((origin) => {
    if (opts.alreadyInjected.has(origin)) return false;
    const data = opts.storage[origin];
    return data && Object.keys(data.localStorage ?? {}).length > 0;
  });

  if (queue.length === 0) {
    return { injected, skipped, durationMs: Date.now() - started };
  }

  const client = new WsCDPClient();
  let detachFulfill: (() => void) | null = null;
  const helperSessionIds = new Set<string>();
  let helpers: { targetId: string; sessionId: string }[] = [];

  try {
    await client.connect(opts.providerWsUrl, totalTimeout);
    detachFulfill = installFetchFulfill(client, helperSessionIds);
    helpers = await openHelperPool(client, Math.min(helperCount, queue.length));
    for (const h of helpers) helperSessionIds.add(h.sessionId);

    // Reserve all queued origins up-front so a lazy hydration mid-flight
    // skips anything we're about to touch. Late drops back to the pool only
    // happen if we never get there (aborted, helper crashed).
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
    await client.close().catch(() => undefined);
  }

  return { injected, skipped, durationMs: Date.now() - started };
}

