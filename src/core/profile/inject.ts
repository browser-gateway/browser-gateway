import type { CDPClient, CdpCookie, RuntimeEvaluateResponse } from "./cdp.js";
import type { CapturedProfile, OriginStorage, SkippedOrigin } from "./types.js";

export interface InjectOptions {
  /** Page.navigate timeout (ms). Default 10_000. */
  navigationTimeoutMs?: number;
  /** Runtime.evaluate timeout (ms). Default 5_000. */
  evaluateTimeoutMs?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface InjectResult {
  cookiesSet: number;
  originsInjected: string[];
  skippedOrigins: SkippedOrigin[];
  durationMs: number;
}

const DEFAULTS = {
  navigationTimeoutMs: 10_000,
  evaluateTimeoutMs: 5_000,
};

/**
 * Inject captured state into a fresh browser via CDP.
 *
 * Cookies are set first via Network.setCookies (no navigation required).
 * For each origin with localStorage/sessionStorage, the page is navigated to
 * the origin and the state is written via Runtime.evaluate.
 *
 * Skipped origins (navigation error, evaluate error) are reported in the
 * result but do not fail the whole inject — best-effort per origin.
 */
export async function injectState(
  cdp: CDPClient,
  profile: CapturedProfile,
  opts: InjectOptions = {},
): Promise<InjectResult> {
  const started = Date.now();
  const navTimeout = opts.navigationTimeoutMs ?? DEFAULTS.navigationTimeoutMs;
  const evalTimeout = opts.evaluateTimeoutMs ?? DEFAULTS.evaluateTimeoutMs;
  const signal = opts.signal;

  if (signal?.aborted) throw new Error("inject aborted");

  await cdp.send("Network.enable").catch(() => undefined);

  let cookiesSet = 0;
  if (profile.cookies.length > 0) {
    await cdp.send("Network.setCookies", {
      cookies: profile.cookies.map(prepareCookieForInject),
    });
    cookiesSet = profile.cookies.length;
  }

  const originsInjected: string[] = [];
  const skippedOrigins: SkippedOrigin[] = [];

  for (const [origin, data] of Object.entries(profile.storage)) {
    if (signal?.aborted) throw new Error("inject aborted");
    if (!hasAnyEntries(data)) continue;
    try {
      await navigateAndWait(cdp, origin, navTimeout);
      const expr = buildStorageWriteExpression(data);
      const result = (await withTimeout(
        cdp.send("Runtime.evaluate", {
          expression: expr,
          returnByValue: true,
          awaitPromise: false,
        }),
        evalTimeout,
        `Runtime.evaluate(write @${origin})`,
      )) as RuntimeEvaluateResponse;

      if (result.exceptionDetails) {
        const msg = result.exceptionDetails.exception?.description
          ?? result.exceptionDetails.text
          ?? "unknown evaluate exception";
        skippedOrigins.push({ origin, reason: `runtime exception: ${msg}` });
        continue;
      }
      const value = result.result?.value;
      if (typeof value !== "object" || value === null) {
        skippedOrigins.push({ origin, reason: "evaluate returned no result" });
        continue;
      }
      originsInjected.push(origin);
    } catch (err) {
      skippedOrigins.push({ origin, reason: errorMessage(err) });
    }
  }

  return {
    cookiesSet,
    originsInjected,
    skippedOrigins,
    durationMs: Date.now() - started,
  };
}

function prepareCookieForInject(c: CdpCookie): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
  };
  if (c.expires !== undefined && c.expires > 0) out.expires = c.expires;
  if (c.sameSite) out.sameSite = c.sameSite;
  if (c.priority) out.priority = c.priority;
  if (c.sourceScheme && c.sourceScheme !== "Unset") out.sourceScheme = c.sourceScheme;
  if (c.sourcePort && c.sourcePort > 0) out.sourcePort = c.sourcePort;
  if (c.sameParty !== undefined) out.sameParty = c.sameParty;
  if (c.partitionKey !== undefined) out.partitionKey = c.partitionKey;
  return out;
}

function buildStorageWriteExpression(data: OriginStorage): string {
  const local = JSON.stringify(data.localStorage ?? {});
  const session = JSON.stringify(data.sessionStorage ?? {});
  return `
    (() => {
      const result = { localStorageWrote: 0, sessionStorageWrote: 0, errors: [] };
      const writeAll = (store, entries) => {
        try { store.clear(); } catch (e) { result.errors.push("clear: " + String(e && e.message || e)); }
        for (const [k, v] of Object.entries(entries)) {
          try {
            store.setItem(k, v);
            return true;
          } catch (e) {
            result.errors.push(k + ": " + String(e && e.message || e));
          }
        }
        return false;
      };
      try {
        const entries = ${local};
        for (const [k, v] of Object.entries(entries)) {
          try { localStorage.setItem(k, v); result.localStorageWrote++; }
          catch (e) { result.errors.push("local " + k + ": " + String(e && e.message || e)); }
        }
      } catch (e) { result.errors.push("localStorage failed: " + String(e && e.message || e)); }
      try {
        const entries = ${session};
        for (const [k, v] of Object.entries(entries)) {
          try { sessionStorage.setItem(k, v); result.sessionStorageWrote++; }
          catch (e) { result.errors.push("session " + k + ": " + String(e && e.message || e)); }
        }
      } catch (e) { result.errors.push("sessionStorage failed: " + String(e && e.message || e)); }
      return result;
    })()
  `;
}

function hasAnyEntries(data: OriginStorage): boolean {
  return (
    Object.keys(data.localStorage ?? {}).length > 0
    || Object.keys(data.sessionStorage ?? {}).length > 0
  );
}

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

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
