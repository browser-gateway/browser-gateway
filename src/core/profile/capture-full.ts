import type { CdpCookie, GetAllCookiesResponse } from "./cdp.js";
import { WsCDPClient } from "./cdp-client.js";
import {
  navigateAndEvaluate,
  runHelperPool,
  withDeadline,
  withHelperPool,
  type HelperPage,
} from "./helper-pool.js";
import type { OriginStorage, SkippedOrigin } from "./types.js";

export interface CaptureFullOptions {
  /** Number of helper pages used for parallel capture. Default 4. */
  helperPages?: number;
  /** Per-origin navigate + evaluate timeout (ms). Default 5_000. */
  perOriginTimeoutMs?: number;
  /** Total wall-clock budget (ms). Default 30_000. */
  totalTimeoutMs?: number;
  /** Also capture origins derived from the session's cookies. Default false. */
  includeCookieDerivedOrigins?: boolean;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface CaptureFullResult {
  cookies: CdpCookie[];
  storage: Record<string, OriginStorage>;
  skippedOrigins: SkippedOrigin[];
  durationMs: number;
}

const STORAGE_DUMP_EXPR = `
  (() => {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k !== null) out[k] = localStorage.getItem(k) ?? "";
      }
    } catch (e) {
      return JSON.stringify({ __error: String(e && e.message || e) });
    }
    return JSON.stringify(out);
  })()
`;

/** Captures cookies and per-origin localStorage on an already-connected client. */
export async function captureFullStateOnClient(
  client: WsCDPClient,
  originsToCapture: string[],
  opts: Omit<CaptureFullOptions, "totalTimeoutMs"> = {},
): Promise<CaptureFullResult> {
  const started = Date.now();
  const helperCount = Math.max(1, opts.helperPages ?? 4);
  const perOriginTimeout = opts.perOriginTimeoutMs ?? 5_000;
  const signal = opts.signal;

  const cookieResp = (await client.send("Storage.getCookies")) as GetAllCookiesResponse | null;
  const cookies: CdpCookie[] = cookieResp?.cookies ?? [];

  let originSet = originsToCapture;
  if (opts.includeCookieDerivedOrigins) {
    const cookieOrigins = originsFromCookies(cookies);
    originSet = Array.from(new Set([...originsToCapture, ...cookieOrigins]));
  }

  if (originSet.length === 0) {
    return { cookies, storage: {}, skippedOrigins: [], durationMs: Date.now() - started };
  }

  const { storage, skipped } = await captureOrigins(client, originSet, {
    helperCount,
    perOriginTimeout,
    signal,
  });

  return { cookies, storage, skippedOrigins: skipped, durationMs: Date.now() - started };
}

/** Opens its own WS to the provider, captures, then closes the WS. */
export async function captureFullStateViaTransient(
  providerWsUrl: string,
  originsToCapture: string[],
  opts: CaptureFullOptions = {},
): Promise<CaptureFullResult> {
  const totalTimeout = opts.totalTimeoutMs ?? 30_000;
  return withDeadline(
    (async () => {
      const client = new WsCDPClient();
      try {
        await client.connect(providerWsUrl, totalTimeout);
        return await captureFullStateOnClient(client, originsToCapture, opts);
      } finally {
        await client.close().catch(() => undefined);
      }
    })(),
    totalTimeout,
    "captureFullStateViaTransient",
  );
}

async function captureOrigins(
  client: WsCDPClient,
  origins: string[],
  cfg: { helperCount: number; perOriginTimeout: number; signal?: AbortSignal },
): Promise<{ storage: Record<string, OriginStorage>; skipped: SkippedOrigin[] }> {
  const storage: Record<string, OriginStorage> = {};
  const skipped: SkippedOrigin[] = [];

  await withHelperPool(client, cfg.helperCount, origins.length, (helpers) =>
    runHelperPool({
      helpers,
      origins,
      signal: cfg.signal,
      work: (origin, helper) => captureOneOrigin(client, helper, origin, cfg.perOriginTimeout),
      onSuccess: (origin, data) => { storage[origin] = data; },
      onError: (origin, reason) => skipped.push({ origin, reason }),
    }),
  );

  return { storage, skipped };
}

async function captureOneOrigin(
  client: WsCDPClient,
  helper: HelperPage,
  origin: string,
  timeoutMs: number,
): Promise<OriginStorage> {
  const value = await navigateAndEvaluate(client, helper, origin, STORAGE_DUMP_EXPR, timeoutMs);

  if (typeof value !== "string") {
    throw new Error("evaluate returned non-string");
  }

  let parsed: Record<string, string> | { __error: string };
  try {
    parsed = JSON.parse(value) as Record<string, string> | { __error: string };
  } catch (err) {
    throw new Error(`invalid JSON from page: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  if ("__error" in parsed) {
    throw new Error(`storage read error: ${parsed.__error}`);
  }

  return {
    localStorage: parsed,
    sessionStorage: {},
    lastVisitedAt: new Date().toISOString(),
  };
}

/** Returns https origin candidates derived from a cookie list. */
export function originsFromCookies(cookies: CdpCookie[]): string[] {
  const set = new Set<string>();
  for (const c of cookies) {
    const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
    if (!domain || /^\d+\.\d+\.\d+\.\d+$/.test(domain) || domain === "localhost") continue;
    set.add(`https://${domain}`);
  }
  return Array.from(set);
}

