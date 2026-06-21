import type { CDPClient, RuntimeEvaluateResponse } from "./cdp.js";
import { navigateAndWait, resolveProfileOptions, withTimeout } from "./cdp-utils.js";
import { prepareCookieForInject } from "./cookie-helpers.js";
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
  const { started, navTimeout, evalTimeout, signal } = resolveProfileOptions(opts, "inject");

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

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
