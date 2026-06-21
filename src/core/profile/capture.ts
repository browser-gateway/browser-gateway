import type {
  CDPClient,
  CdpCookie,
  GetAllCookiesResponse,
  RuntimeEvaluateResponse,
} from "./cdp.js";
import {
  PROFILE_VERSION,
  type CapturedProfile,
  type OriginStorage,
  type SkippedOrigin,
} from "./types.js";

export interface CaptureOptions {
  /** Origins to capture localStorage + sessionStorage for. Cookies are always captured. */
  origins?: string[];
  /** Page.navigate timeout (ms). Default 10_000. */
  navigationTimeoutMs?: number;
  /** Runtime.evaluate timeout (ms). Default 5_000. */
  evaluateTimeoutMs?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

const DEFAULTS = {
  navigationTimeoutMs: 10_000,
  evaluateTimeoutMs: 5_000,
};

const STORAGE_DUMP_EXPR = `
  (() => {
    const dump = (s) => {
      const out = {};
      try {
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (k !== null) out[k] = s.getItem(k) ?? "";
        }
      } catch (e) {
        return { __error: String(e && e.message || e) };
      }
      return out;
    };
    return JSON.stringify({
      localStorage: dump(localStorage),
      sessionStorage: dump(sessionStorage),
    });
  })()
`;

const USER_AGENT_EXPR = "navigator.userAgent";

/**
 * Capture browser state from a CDP session for cross-session replay.
 *
 * Captures: cookies (all), localStorage (per-origin), sessionStorage (per-origin), userAgent.
 * Skips: HTTP cache, code cache, service workers, IndexedDB (v2), in-memory state.
 *
 * Per-origin storage capture is best-effort. If one origin fails (network error,
 * runtime exception, navigation timeout) it's added to `meta.skippedOrigins`
 * and the rest of the capture proceeds.
 */
export async function captureState(
  cdp: CDPClient,
  opts: CaptureOptions = {},
): Promise<CapturedProfile> {
  const started = Date.now();
  const navTimeout = opts.navigationTimeoutMs ?? DEFAULTS.navigationTimeoutMs;
  const evalTimeout = opts.evaluateTimeoutMs ?? DEFAULTS.evaluateTimeoutMs;
  const signal = opts.signal;

  if (signal?.aborted) throw new Error("capture aborted");

  const cookieResp = (await cdp.send("Network.getAllCookies")) as GetAllCookiesResponse;
  const cookies: CdpCookie[] = cookieResp?.cookies ?? [];

  const origins = uniqueOrigins(opts.origins ?? []);
  const storage: Record<string, OriginStorage> = {};
  const capturedOrigins: string[] = [];
  const skippedOrigins: SkippedOrigin[] = [];

  for (const origin of origins) {
    if (signal?.aborted) throw new Error("capture aborted");
    try {
      await navigateAndWait(cdp, origin, navTimeout);
      const dump = await evaluateExpression(cdp, STORAGE_DUMP_EXPR, evalTimeout);
      if (typeof dump !== "string") {
        skippedOrigins.push({ origin, reason: "evaluate returned non-string" });
        continue;
      }
      const parsed = JSON.parse(dump) as {
        localStorage: Record<string, string> | { __error?: string };
        sessionStorage: Record<string, string> | { __error?: string };
      };
      if (isErrorBag(parsed.localStorage) || isErrorBag(parsed.sessionStorage)) {
        skippedOrigins.push({ origin, reason: "storage read error in page context" });
        continue;
      }
      storage[origin] = {
        localStorage: parsed.localStorage as Record<string, string>,
        sessionStorage: parsed.sessionStorage as Record<string, string>,
      };
      capturedOrigins.push(origin);
    } catch (err) {
      skippedOrigins.push({ origin, reason: errorMessage(err) });
    }
  }

  let userAgent: string | undefined;
  try {
    const ua = await evaluateExpression(cdp, USER_AGENT_EXPR, evalTimeout);
    if (typeof ua === "string") userAgent = ua;
  } catch {
    // best-effort
  }

  return {
    version: PROFILE_VERSION,
    capturedAt: new Date().toISOString(),
    cookies,
    storage,
    meta: {
      userAgent,
      capturedOrigins,
      skippedOrigins,
      durationMs: Date.now() - started,
    },
  };
}

/** Navigate the CDP target to the given URL and wait for the page to be evaluable. */
async function navigateAndWait(cdp: CDPClient, url: string, timeoutMs: number): Promise<void> {
  await cdp.send("Page.enable").catch(() => undefined);

  const navigatePromise = cdp.send("Page.navigate", { url });
  const loadPromise = waitForEvent(cdp, "Page.loadEventFired", timeoutMs).catch(() => undefined);

  const navResult = (await withTimeout(navigatePromise, timeoutMs, `navigate(${url})`)) as {
    errorText?: string;
  } | undefined;
  if (navResult?.errorText) {
    throw new Error(`navigate ${url} failed: ${navResult.errorText}`);
  }
  await loadPromise;
}

async function evaluateExpression(
  cdp: CDPClient,
  expression: string,
  timeoutMs: number,
): Promise<unknown> {
  const resp = (await withTimeout(
    cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
    }),
    timeoutMs,
    "Runtime.evaluate",
  )) as RuntimeEvaluateResponse;

  if (resp.exceptionDetails) {
    const msg = resp.exceptionDetails.exception?.description
      ?? resp.exceptionDetails.text
      ?? "unknown evaluate exception";
    throw new Error(`runtime exception: ${msg}`);
  }
  return resp.result?.value;
}

function waitForEvent(cdp: CDPClient, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onFire = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      try { (cdp.off as (e: string, l: unknown) => unknown)(event, onFire); } catch {}
    };
    (cdp.on as (e: string, l: unknown) => unknown)(event, onFire);
  });
}

function withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms: ${label}`)), timeoutMs),
    ),
  ]);
}

function uniqueOrigins(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const normalized = normalizeOrigin(raw);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

function isErrorBag(v: unknown): v is { __error: string } {
  return typeof v === "object" && v !== null && "__error" in v;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
