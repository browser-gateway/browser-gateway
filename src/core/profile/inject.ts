import type { CDPClient, RuntimeEvaluateResponse } from "./cdp.js";
import { navigateAndWait, resolveProfileOptions, withTimeout } from "./cdp-utils.js";
import { sanitizeCookiesForInject } from "./cookie-helpers.js";
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
 * For each origin with localStorage, the page is navigated to the origin and
 * the state is written via Runtime.evaluate. sessionStorage is never restored;
 * it is tab-scoped and replaying it breaks OAuth and CSRF flows.
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
      cookies: sanitizeCookiesForInject(profile.cookies),
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
  return `
    (() => {
      const result = { localStorageWrote: 0, sessionStorageWrote: 0, errors: [] };
      try { sessionStorage.clear(); } catch (e) { result.errors.push("sessionStorage.clear failed: " + String(e && e.message || e)); }
      try {
        const entries = ${local};
        for (const [k, v] of Object.entries(entries)) {
          try { localStorage.setItem(k, v); result.localStorageWrote++; }
          catch (e) { result.errors.push("local " + k + ": " + String(e && e.message || e)); }
        }
      } catch (e) { result.errors.push("localStorage failed: " + String(e && e.message || e)); }
      return result;
    })()
  `;
}

function hasAnyEntries(data: OriginStorage): boolean {
  return Object.keys(data.localStorage ?? {}).length > 0;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
