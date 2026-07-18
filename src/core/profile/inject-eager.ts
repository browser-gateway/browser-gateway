import type { CdpCookie } from "./cdp.js";
import { WsCDPClient } from "./cdp-client.js";
import { prepareCookieForInject } from "./cookie-helpers.js";
import {
  navigateAndEvaluate,
  runHelperPool,
  withDeadline,
  withHelperPool,
} from "./helper-pool.js";
import type { CapturedProfile, OriginStorage, SkippedOrigin } from "./types.js";

export interface EagerInjectOptions {
  /** Number of helper pages used for parallel inject. Default 4. */
  helperPages?: number;
  /** Eagerly inject the top-K origins; defer the rest. Default 20. */
  eagerOriginLimit?: number;
  /** Per-origin navigate + evaluate timeout (ms). Default 5_000. */
  perOriginTimeoutMs?: number;
  /** Total wall-clock budget (ms). Default 10_000. */
  totalTimeoutMs?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface EagerInjectResult {
  cookiesSet: number;
  originsInjected: string[];
  /** Origins not attempted because they were below the K cutoff. */
  originsDeferred: string[];
  /** Origins attempted but failed; reason captured per origin. */
  skippedOrigins: SkippedOrigin[];
  durationMs: number;
}

/** Eagerly injects cookies and the top-K origins' localStorage on an already-connected client. */
export async function injectStateEager(
  client: WsCDPClient,
  profile: CapturedProfile,
  opts: Omit<EagerInjectOptions, "totalTimeoutMs"> = {},
): Promise<EagerInjectResult> {
  const started = Date.now();
  const helperCount = Math.max(1, opts.helperPages ?? 4);
  const limit = Math.max(0, opts.eagerOriginLimit ?? 20);
  const perOriginTimeout = opts.perOriginTimeoutMs ?? 5_000;
  const signal = opts.signal;

  const cookiesSet = await injectCookies(client, profile.cookies);

  const ranked = rankOrigins(profile.storage);
  const eagerOrigins = ranked.slice(0, limit);
  const deferred = ranked.slice(limit);

  if (eagerOrigins.length === 0) {
    return {
      cookiesSet,
      originsInjected: [],
      originsDeferred: deferred,
      skippedOrigins: [],
      durationMs: Date.now() - started,
    };
  }

  const { injected, skipped } = await injectEagerOrigins(
    client,
    eagerOrigins,
    profile.storage,
    { helperCount, perOriginTimeout, signal },
  );

  return {
    cookiesSet,
    originsInjected: injected,
    originsDeferred: deferred,
    skippedOrigins: skipped,
    durationMs: Date.now() - started,
  };
}

/** Opens a fresh WS to the provider, runs the eager inject, then closes the WS. */
export async function injectStateEagerViaTransient(
  providerWsUrl: string,
  profile: CapturedProfile,
  opts: EagerInjectOptions = {},
): Promise<EagerInjectResult> {
  const totalTimeout = opts.totalTimeoutMs ?? 10_000;
  return withDeadline(
    (async () => {
      const client = new WsCDPClient();
      try {
        await client.connect(providerWsUrl, totalTimeout);
        return await injectStateEager(client, profile, opts);
      } finally {
        await client.close().catch(() => undefined);
      }
    })(),
    totalTimeout,
    "injectStateEagerViaTransient",
  );
}

async function injectCookies(client: WsCDPClient, cookies: CdpCookie[]): Promise<number> {
  await client.send("Storage.clearCookies", {}).catch(() => undefined);
  if (cookies.length === 0) return 0;
  await client.send("Storage.setCookies", { cookies: cookies.map(prepareCookieForInject) });
  return cookies.length;
}

async function injectEagerOrigins(
  client: WsCDPClient,
  origins: string[],
  storage: Record<string, OriginStorage>,
  cfg: { helperCount: number; perOriginTimeout: number; signal?: AbortSignal },
): Promise<{ injected: string[]; skipped: SkippedOrigin[] }> {
  const injected: string[] = [];
  const skipped: SkippedOrigin[] = [];

  await withHelperPool(client, cfg.helperCount, origins.length, (helpers) => {
    const targetOrigins = origins.filter((o) => hasLocal(storage[o]));
    return runHelperPool({
      helpers,
      origins: targetOrigins,
      signal: cfg.signal,
      work: (origin, helper) =>
        navigateAndEvaluate(
          client,
          helper,
          origin,
          buildLocalStorageWriteExpression(storage[origin]),
          cfg.perOriginTimeout,
        ),
      onSuccess: (origin) => injected.push(origin),
      onError: (origin, reason) => skipped.push({ origin, reason }),
    });
  });

  return { injected, skipped };
}

/** Returns a JS expression that writes the origin's localStorage entries. */
export function buildLocalStorageWriteExpression(data: OriginStorage): string {
  const local = JSON.stringify(data.localStorage ?? {});
  return `
    (() => {
      const result = { wrote: 0, errors: [] };
      try { localStorage.clear(); } catch (e) { result.errors.push("localStorage.clear failed: " + String(e && e.message || e)); }
      try { sessionStorage.clear(); } catch (e) { result.errors.push("sessionStorage.clear failed: " + String(e && e.message || e)); }
      try {
        const entries = ${local};
        for (const [k, v] of Object.entries(entries)) {
          try { localStorage.setItem(k, v); result.wrote++; }
          catch (e) { result.errors.push(k + ": " + String(e && e.message || e)); }
        }
      } catch (e) { result.errors.push("localStorage failed: " + String(e && e.message || e)); }
      return result;
    })()
  `;
}

/** Returns origins sorted by lastVisitedAt descending. */
export function rankOrigins(storage: Record<string, OriginStorage>): string[] {
  return Object.entries(storage)
    .map(([origin, data]) => ({
      origin,
      ts: data.lastVisitedAt ? Date.parse(data.lastVisitedAt) : 0,
    }))
    .sort((a, b) => b.ts - a.ts)
    .map((x) => x.origin);
}

function hasLocal(data: OriginStorage | undefined): boolean {
  if (!data) return false;
  return Object.keys(data.localStorage ?? {}).length > 0;
}

