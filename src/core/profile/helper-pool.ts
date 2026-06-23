/**
 * Shared helper-page-pool primitives used by inject-eager, inject-background,
 * and capture-full.
 *
 * All three paths follow the same shape: open N targets, install Fetch
 * interception so navigation costs ~50 ms instead of 200+, walk a list of
 * origins round-robin across the helpers, then clean up.
 *
 * Centralizing here keeps the three paths consistent (one set of timeouts,
 * one fulfill-response shape, one cleanup sequence) and makes jscpd happy.
 */
import type { WsCDPClient } from "./cdp-client.js";

export interface HelperPage {
  targetId: string;
  sessionId: string;
}

const FETCH_FULFILL_BODY_B64 = Buffer.from("<html></html>").toString("base64");

/** Open one helper target + attach flat-mode + enable Fetch + enable Page. */
export async function openHelperPage(client: WsCDPClient): Promise<HelperPage> {
  const created = (await client.send("Target.createTarget", { url: "about:blank" })) as {
    targetId: string;
  };
  const attached = (await client.send("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true,
  })) as { sessionId: string };
  await client.sendOn("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, attached.sessionId);
  await client.sendOn("Page.enable", {}, attached.sessionId);
  return { targetId: created.targetId, sessionId: attached.sessionId };
}

/**
 * Register a Fetch.requestPaused listener that fulfills every request scoped
 * to one of the helper sessions with empty HTML. The returned function
 * removes the listener.
 */
export function installFetchFulfill(
  client: WsCDPClient,
  helperSessionIds: Set<string>,
): () => void {
  const onPaused = (params: unknown) => {
    const p = params as { requestId?: string; __sessionId?: string };
    if (!p.requestId || !p.__sessionId) return;
    if (!helperSessionIds.has(p.__sessionId)) return;
    void client
      .sendOn(
        "Fetch.fulfillRequest",
        {
          requestId: p.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "text/html" }],
          body: FETCH_FULFILL_BODY_B64,
        },
        p.__sessionId,
      )
      .catch(() => undefined);
  };
  client.on("Fetch.requestPaused", onPaused);
  return () => {
    try {
      client.off("Fetch.requestPaused", onPaused);
    } catch {
      // ignore
    }
  };
}

/** Close every helper target and best-effort `Fetch.disable` each session. */
export async function closeHelperPages(client: WsCDPClient, helpers: HelperPage[]): Promise<void> {
  await Promise.allSettled(
    helpers.map(async (h) => {
      await client.sendOn("Fetch.disable", {}, h.sessionId).catch(() => undefined);
      await client.send("Target.closeTarget", { targetId: h.targetId }).catch(() => undefined);
    }),
  );
}

/** Open up to `count` helper pages. Returns however many succeeded. */
export async function openHelperPool(
  client: WsCDPClient,
  count: number,
): Promise<HelperPage[]> {
  const helpers: HelperPage[] = [];
  for (let i = 0; i < count; i++) {
    try {
      helpers.push(await openHelperPage(client));
    } catch (err) {
      if (helpers.length === 0) throw err;
      break;
    }
  }
  return helpers;
}

/** Race a Promise against a per-operation timeout. Rejects with a labeled error. */
export function raceTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout (${timeoutMs}ms): ${label}`)), timeoutMs),
    ),
  ]);
}

/**
 * Hard wall-clock deadline around a whole operation. Necessary because
 * individual CDP `send` calls have no built-in timeout, so a hung peer could
 * otherwise keep the profile lock held indefinitely.
 */
export function withDeadline<T>(op: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
    op.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Navigate the helper to an origin (Fetch.fulfillRequest will satisfy it
 * with empty HTML), then Runtime.evaluate the given expression. Raises a
 * single uniform error on either timeout or page-context exception. Returns
 * the evaluated value (or null if no result).
 */
export async function navigateAndEvaluate(
  client: WsCDPClient,
  helper: HelperPage,
  origin: string,
  expression: string,
  timeoutMs: number,
): Promise<unknown> {
  await raceTimeout(
    client.sendOn("Page.navigate", { url: origin + "/" }, helper.sessionId),
    timeoutMs,
    `navigate ${origin}`,
  );
  const resp = (await raceTimeout(
    client.sendOn(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: false },
      helper.sessionId,
    ),
    timeoutMs,
    `evaluate ${origin}`,
  )) as RuntimeEvaluateResponse | null;

  if (resp?.exceptionDetails) {
    throw new Error(
      "runtime exception: " +
        (resp.exceptionDetails.exception?.description ??
          resp.exceptionDetails.text ??
          "unknown exception"),
    );
  }
  return resp?.result?.value;
}

interface RuntimeEvaluateResponse {
  result?: { type?: string; value?: unknown };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string };
  };
}

/**
 * Round-robin worker loop over `origins` across `helpers`. Each helper grabs
 * the next index in the shared queue and calls `work(origin, helper)`. Errors
 * are routed to `onError` per-origin; the loop never aborts the others.
 *
 * `abortSignal` is checked at the top of each iteration so a hung work() can
 * still finish its current origin even after abort, but no new ones are
 * picked up.
 */
export async function runHelperPool<T>(opts: {
  helpers: HelperPage[];
  origins: string[];
  work: (origin: string, helper: HelperPage) => Promise<T>;
  onSuccess: (origin: string, result: T) => void;
  onError: (origin: string, reason: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  let cursor = 0;
  await Promise.allSettled(
    opts.helpers.map(async (helper) => {
      while (true) {
        if (opts.signal?.aborted) return;
        const idx = cursor++;
        if (idx >= opts.origins.length) return;
        const origin = opts.origins[idx];
        try {
          const v = await opts.work(origin, helper);
          opts.onSuccess(origin, v);
        } catch (err) {
          opts.onError(origin, err instanceof Error ? err.message : String(err));
        }
      }
    }),
  );
}
