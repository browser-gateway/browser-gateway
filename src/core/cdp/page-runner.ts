/**
 * Isomorphic page-runner — Playwright's page.* high-level API rewritten as
 * raw CDP commands on top of `CdpProtocolClient`. Runs anywhere the CDP client
 * runs (Node, Cloudflare Workers, browser).
 *
 * Contract: caller opens a CDP connection + attaches to a page target,
 * hands us the sessionId. We do NOT manage target lifecycle (create/close).
 * That's the caller's job so cleanup is explicit at the call site.
 *
 * Screenshot capture must always run Emulation.setDeviceMetricsOverride BEFORE
 * Page.captureScreenshot — same Chromium quirk as Page.startScreencast
 * (puppeteer/puppeteer#10527). runPageAction() handles this via the viewport
 * setup step.
 */

import type { CdpProtocolClient } from "./protocol.js";

/** Options that shape the pre-action page setup + navigation.
 *  Mirrors the OSS REST schema BaseFields (browser-gateway/rest-schemas). */
export interface PageOptions {
  url: string;
  viewport?: { width: number; height: number };
  headers?: Record<string, string>;
  userAgent?: string;
  /** Navigation wait strategy. `load` = load event fired,
   *  `domcontentloaded` = DOMContentLoaded fired,
   *  `commit` = navigation committed (fastest),
   *  `networkidle` = ≥500ms with 0 in-flight requests (slowest, most reliable). */
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  waitForSelector?: string;
  waitForTimeout?: number;
  /** Nav timeout in ms. Default 30_000. */
  timeout?: number;
  /** Client-disconnect signal. When aborted, runPageAction throws an AbortError
   *  before / between CDP calls so a disconnected caller doesn't keep the browser busy. */
  signal?: AbortSignal;
}

/** Thrown when {@link PageOptions.signal} aborts mid-run. Server callers should
 *  map `error.name === "AbortError"` to HTTP 499 (matches OSS REST behaviour). */
export class AbortError extends Error {
  override name = "AbortError";
  constructor(message = "aborted") {
    super(message);
  }
}

/** Result payload from runPageAction. */
export interface PageRunResult<T> {
  data: T;
  statusCode: number | null;
  resolvedUrl: string;
  navigationMs: number;
  actionMs: number;
}

interface NavigateResult {
  frameId?: string;
  loaderId?: string;
  errorText?: string;
}

interface EvaluateResult {
  result?: {
    type: string;
    value?: unknown;
    description?: string;
    subtype?: string;
  };
  exceptionDetails?: {
    text: string;
    exception?: { description?: string; value?: unknown };
  };
}

interface CaptureScreenshotResult {
  data: string;
}

/** Screenshot capture options passed to Page.captureScreenshot. */
export interface ScreenshotOpts {
  format?: "png" | "jpeg" | "webp";
  quality?: number;
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
  captureBeyondViewport?: boolean;
  fromSurface?: boolean;
  omitBackground?: boolean;
}

const DEFAULT_NAV_TIMEOUT_MS = 30_000;
const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const SELECTOR_POLL_INTERVAL_MS = 100;
const SELECTOR_POLL_TIMEOUT_MS = 10_000;

/** Throw AbortError when `signal.aborted` is true. Cheap synchronous check. */
function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortError();
}

/**
 * Run a user action against a page. Handles viewport/header/UA setup,
 * navigation, wait strategies, then invokes the action. Throws on any CDP
 * failure or navigation-timeout (unless `tolerateGotoTimeout` is set — see
 * OSS screenshot handler for why: some slow pages produce useful screenshots
 * even without full navigation completion).
 */
export async function runPageAction<T>(
  cdp: CdpProtocolClient,
  sessionId: string,
  options: PageOptions,
  action: (cdp: CdpProtocolClient, sessionId: string) => Promise<T>,
  runOpts: { tolerateGotoTimeout?: boolean } = {},
): Promise<PageRunResult<T>> {
  checkAborted(options.signal);
  await cdp.sendOn("Page.enable", {}, sessionId);
  await cdp.sendOn("Runtime.enable", {}, sessionId);
  await cdp.sendOn("Network.enable", {}, sessionId);
  checkAborted(options.signal);

  if (options.viewport) {
    await cdp.sendOn(
      "Emulation.setDeviceMetricsOverride",
      {
        width: options.viewport.width,
        height: options.viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      },
      sessionId,
    );
  }

  if (options.userAgent) {
    await cdp.sendOn("Network.setUserAgentOverride", { userAgent: options.userAgent }, sessionId);
  }

  if (options.headers) {
    await cdp.sendOn("Network.setExtraHTTPHeaders", { headers: options.headers }, sessionId);
  }
  checkAborted(options.signal);

  const navStart = Date.now();
  let statusCode: number | null = null;
  let mainFrameId: string | undefined;

  const responseHandler = (params: Record<string, unknown>): void => {
    const p = params as { frameId?: string; response?: { status?: number; url?: string } };
    if (p.frameId && p.frameId === mainFrameId && typeof p.response?.status === "number") {
      statusCode = p.response.status;
    }
  };
  cdp.on("Network.responseReceived", responseHandler);

  try {
    const navResult = (await cdp.sendOn(
      "Page.navigate",
      { url: options.url, transitionType: "typed" },
      sessionId,
    )) as NavigateResult;
    mainFrameId = navResult.frameId;
    if (navResult.errorText) {
      throw new Error(`Page.navigate failed: ${navResult.errorText}`);
    }

    const waitUntil = options.waitUntil ?? "load";
    const timeout = options.timeout ?? DEFAULT_NAV_TIMEOUT_MS;
    if (waitUntil !== "commit") {
      try {
        await waitForNavigation(cdp, sessionId, waitUntil, mainFrameId, timeout, options.signal);
      } catch (err) {
        if (!runOpts.tolerateGotoTimeout) throw err;
      }
    }
  } finally {
    cdp.off("Network.responseReceived", responseHandler);
  }

  checkAborted(options.signal);
  const navigationMs = Date.now() - navStart;

  if (options.waitForSelector) {
    await waitForSelector(cdp, sessionId, options.waitForSelector, SELECTOR_POLL_TIMEOUT_MS, options.signal);
  }
  if (options.waitForTimeout && options.waitForTimeout > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, options.waitForTimeout));
  }
  checkAborted(options.signal);

  const resolvedUrl = await evaluateInPage<string>(cdp, sessionId, "window.location.href");

  checkAborted(options.signal);
  const actionStart = Date.now();
  const data = await withTimeout(
    action(cdp, sessionId),
    DEFAULT_ACTION_TIMEOUT_MS,
    "action timed out",
    options.signal,
  );
  const actionMs = Date.now() - actionStart;

  return { data, statusCode, resolvedUrl, navigationMs, actionMs };
}

/**
 * Capture a full-viewport or clipped screenshot as a Uint8Array of image bytes.
 * `format` defaults to "png"; `quality` only applies to jpeg/webp.
 * `captureBeyondViewport` corresponds to Playwright's `fullPage: true`.
 */
export async function captureScreenshot(
  cdp: CdpProtocolClient,
  sessionId: string,
  opts: ScreenshotOpts = {},
): Promise<Uint8Array> {
  const params: Record<string, unknown> = {
    format: opts.format ?? "png",
  };
  if ((opts.format === "jpeg" || opts.format === "webp") && typeof opts.quality === "number") {
    params.quality = opts.quality;
  }
  if (opts.clip) {
    params.clip = {
      x: opts.clip.x,
      y: opts.clip.y,
      width: opts.clip.width,
      height: opts.clip.height,
      scale: opts.clip.scale ?? 1,
    };
  }
  if (opts.captureBeyondViewport !== undefined) {
    params.captureBeyondViewport = opts.captureBeyondViewport;
  }
  if (opts.fromSurface !== undefined) {
    params.fromSurface = opts.fromSurface;
  }
  if (opts.omitBackground) {
    params.optimizeForSpeed = false;
  }
  const result = (await cdp.sendOn("Page.captureScreenshot", params, sessionId)) as CaptureScreenshotResult;
  return decodeBase64(result.data);
}

/**
 * Return the outer HTML of the current document. Equivalent to Playwright's
 * page.content() modulo doctype which Playwright synthesizes; here we return
 * exactly what Chromium serializes.
 */
export async function capturePageHTML(cdp: CdpProtocolClient, sessionId: string): Promise<string> {
  return evaluateInPage<string>(cdp, sessionId, "document.documentElement.outerHTML");
}

/** Options for {@link evaluateInPage}. Defaults mirror Playwright's `page.evaluate`
 *  (returnByValue: true, awaitPromise: true). Callers with a known-sync expression
 *  can pass `awaitPromise: false` for a tiny latency win. */
export interface EvaluateOpts {
  awaitPromise?: boolean;
  returnByValue?: boolean;
}

/**
 * Run an arbitrary JS expression in the page context and return its value.
 * Throws on runtime exception or unexpected result shape. Value must be
 * JSON-serializable when `returnByValue` is true (the default).
 */
export async function evaluateInPage<T>(
  cdp: CdpProtocolClient,
  sessionId: string,
  expression: string,
  opts: EvaluateOpts = {},
): Promise<T> {
  const result = (await cdp.sendOn(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: opts.returnByValue ?? true,
      awaitPromise: opts.awaitPromise ?? true,
    },
    sessionId,
  )) as EvaluateResult;
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.exception?.value
      ?? result.exceptionDetails.text;
    throw new Error(`Runtime.evaluate threw: ${String(msg)}`);
  }
  if (!result.result) throw new Error("Runtime.evaluate returned no result");
  return result.result.value as T;
}

/**
 * Capture a screenshot clipped to a CSS-selector-scoped element. Returns 0-byte
 * safe error via thrown Error when the selector doesn't match — the server layer
 * maps that to HTTP 400 (OSS behaviour parity).
 *
 * Uses `getBoundingClientRect` via {@link evaluateInPage} rather than
 * `DOM.getBoxModel` so we don't need to enable the DOM domain and don't pay the
 * cost of a full DOM node tree walk.
 */
export async function captureElementScreenshot(
  cdp: CdpProtocolClient,
  sessionId: string,
  selector: string,
  opts: ScreenshotOpts = {},
): Promise<Uint8Array> {
  const rect = await evaluateInPage<{ x: number; y: number; width: number; height: number } | null>(
    cdp,
    sessionId,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      if (typeof el.scrollIntoViewIfNeeded === "function") {
        el.scrollIntoViewIfNeeded();
      } else if (typeof el.scrollIntoView === "function") {
        el.scrollIntoView();
      }
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  );
  if (!rect) throw new Error(`Selector "${selector}" not found on page`);
  return captureScreenshot(cdp, sessionId, {
    ...opts,
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
  });
}

/**
 * Scroll from top to bottom in half-viewport steps to trigger lazy-loaded content,
 * then return to the top. Matches the OSS `scrollThroughPage` shape verbatim so
 * the two runtimes produce identical scroll behaviour before capture.
 *
 * Runs the whole scroll as a single `Runtime.evaluate` call so the driver-side
 * cost is one CDP round-trip regardless of page height.
 */
export async function scrollThroughPage(cdp: CdpProtocolClient, sessionId: string): Promise<void> {
  await evaluateInPage(
    cdp,
    sessionId,
    `(async () => {
      const scrollStep = Math.floor(window.innerHeight / 2);
      await new Promise((resolve) => {
        function scrollDown() {
          window.scrollBy(0, scrollStep);
          if (
            document.body.scrollHeight -
              (window.pageYOffset + window.innerHeight) <
            scrollStep
          ) {
            window.scrollTo(0, 0);
            setTimeout(resolve, 500);
            return;
          }
          setTimeout(scrollDown, 100);
        }
        scrollDown();
      });
    })()`,
  );
}

/** Poll `document.querySelector(sel) != null` until match, timeout, or abort. */
async function waitForSelector(
  cdp: CdpProtocolClient,
  sessionId: string,
  selector: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const expr = `!!document.querySelector(${JSON.stringify(selector)})`;
  while (Date.now() < deadline) {
    checkAborted(signal);
    const present = await evaluateInPage<boolean>(cdp, sessionId, expr);
    if (present) return;
    await new Promise<void>((resolve) => setTimeout(resolve, SELECTOR_POLL_INTERVAL_MS));
  }
  throw new Error(`waitForSelector timed out after ${timeoutMs}ms: ${selector}`);
}

/** Wait for a Page lifecycle event matching the requested waitUntil. */
async function waitForNavigation(
  cdp: CdpProtocolClient,
  sessionId: string,
  waitUntil: "load" | "domcontentloaded" | "networkidle",
  frameId: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const eventName = waitUntil === "load"
    ? "Page.loadEventFired"
    : waitUntil === "domcontentloaded"
      ? "Page.domContentEventFired"
      : "Page.lifecycleEvent";

  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      cdp.off(eventName, handler);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`navigation timed out after ${timeoutMs}ms (waitUntil=${waitUntil})`));
    }, timeoutMs);
    const onAbort = (): void => {
      cleanup();
      reject(new AbortError());
    };
    if (signal?.aborted) {
      cleanup();
      reject(new AbortError());
      return;
    }
    signal?.addEventListener("abort", onAbort);

    const handler = (params: Record<string, unknown>): void => {
      const p = params as { frameId?: string; name?: string };
      if (frameId && p.frameId && p.frameId !== frameId) return;
      if (waitUntil === "networkidle" && p.name !== "networkIdle") return;
      cleanup();
      resolve();
    };
    cdp.on(eventName, handler);
  });
}

/** Race a promise against a wall-clock timeout and (optionally) an abort signal. */
async function withTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  const abort = new Promise<never>((_, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(new AbortError());
      return;
    }
    signal.addEventListener("abort", () => reject(new AbortError()), { once: true });
  });
  try {
    return await Promise.race([p, timeout, abort]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Base64 decode without Node Buffer (Workers-compatible via atob). */
function decodeBase64(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
