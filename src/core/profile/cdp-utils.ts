/**
 * Shared CDP helpers used by both the capture and inject paths.
 *
 * Both flows do "navigate, evaluate JS, return result" per-origin sequences,
 * with the same timeout/wait/exception-handling around them. Extracted here so
 * the navigation contract stays consistent across capture and inject.
 */
import type { CDPClient, RuntimeEvaluateResponse } from "./cdp.js";

/** Default timeouts for profile capture and inject paths. */
export const PROFILE_DEFAULTS = {
  navigationTimeoutMs: 10_000,
  evaluateTimeoutMs: 5_000,
} as const;

export interface ProfileOpsOptions {
  navigationTimeoutMs?: number;
  evaluateTimeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Resolve the common shape of options for both `captureState` and `injectState`:
 * stamps `started`, picks up timeouts (falling back to {@link PROFILE_DEFAULTS}),
 * and throws if the signal was already aborted.
 *
 * @param abortLabel  Word used in the abort error message — e.g. "capture" or
 *                    "inject" — so callers see which op was aborted.
 */
export function resolveProfileOptions(
  opts: ProfileOpsOptions,
  abortLabel: string,
): { started: number; navTimeout: number; evalTimeout: number; signal?: AbortSignal } {
  const signal = opts.signal;
  if (signal?.aborted) throw new Error(`${abortLabel} aborted`);
  return {
    started: Date.now(),
    navTimeout: opts.navigationTimeoutMs ?? PROFILE_DEFAULTS.navigationTimeoutMs,
    evalTimeout: opts.evaluateTimeoutMs ?? PROFILE_DEFAULTS.evaluateTimeoutMs,
    signal,
  };
}


/** Wrap a Promise with a hard deadline. Rejects with a labelled error on timeout. */
export function withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms: ${label}`)), timeoutMs),
    ),
  ]);
}

/** Resolve once `event` fires on the CDP client. Times out after `timeoutMs`. */
export function waitForEvent(cdp: CDPClient, event: string, timeoutMs: number): Promise<void> {
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

/** Navigate the CDP target to the given URL and wait for the page to be evaluable. */
export async function navigateAndWait(cdp: CDPClient, url: string, timeoutMs: number): Promise<void> {
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

/** Run Runtime.evaluate with timeout + structured exception handling. */
export async function evaluateExpression(
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
