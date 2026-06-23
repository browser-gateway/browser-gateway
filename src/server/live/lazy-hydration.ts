/**
 * Lazy localStorage hydration on the playground's main target.
 *
 * After the eager-K inject finishes, the remaining "cold" origins (the long
 * tail of sites not visited recently) are NOT pre-loaded. Instead this module
 * watches the bridge's main target for top-level Page.frameNavigated events
 * and injects an origin's localStorage the first time the user actually
 * navigates to that origin. Cost is one Runtime.evaluate (~10 ms) per origin,
 * invisible during navigation.
 *
 * The `alreadyInjected` Set is shared with the background loader (PR 2) so
 * the two paths never double-inject the same origin.
 */
import type { Logger } from "pino";
import type { CdpClient } from "./cdp-client.js";
import { raceTimeout } from "../../core/profile/helper-pool.js";
import { buildLocalStorageWriteExpression } from "../../core/profile/inject-eager.js";
import type { OriginStorage } from "../../core/profile/types.js";

export interface LazyHydrationDeps {
  /** The same CdpClient the screencast bridge uses (already connected). */
  cdp: CdpClient;
  /** Flat-mode sessionId of the bridge's main target. */
  mainSessionId: string;
  /** Per-origin storage from the profile. */
  storage: Record<string, OriginStorage>;
  /** Origins that have already been injected (eager or background). */
  alreadyInjected: Set<string>;
  evaluateTimeoutMs?: number;
  logger: Logger;
}

/**
 * Install a Page.frameNavigated listener that lazily injects storage. Returns
 * a teardown function the caller should call on session close.
 */
export function installLazyHydration(deps: LazyHydrationDeps): () => void {
  const evalTimeout = deps.evaluateTimeoutMs ?? 3_000;

  const offEvent = deps.cdp.on((event) => {
    if (event.method !== "Page.frameNavigated") return;
    const p = event.params as { frame?: { url?: string; parentId?: string } };
    if (!p.frame || p.frame.parentId) return; // top-level only
    if (!p.frame.url) return;

    let origin: string;
    try {
      origin = new URL(p.frame.url).origin;
    } catch {
      return;
    }

    if (deps.alreadyInjected.has(origin)) return;
    const data = deps.storage[origin];
    if (!data || Object.keys(data.localStorage ?? {}).length === 0) return;

    // Mark BEFORE the async evaluate. If two close-spaced navigations land,
    // only the first triggers the inject; the second sees alreadyInjected.
    deps.alreadyInjected.add(origin);

    void (async () => {
      try {
        const expr = buildLocalStorageWriteExpression(data);
        await raceTimeout(
          deps.cdp.send("Runtime.evaluate", {
            expression: expr,
            returnByValue: true,
            awaitPromise: false,
          }, deps.mainSessionId),
          evalTimeout,
          `lazy evaluate ${origin}`,
        );
        deps.logger.info(
          { origin, keys: Object.keys(data.localStorage).length },
          "live: lazy-hydrated origin",
        );
      } catch (err) {
        deps.logger.warn(
          { origin, error: err instanceof Error ? err.message : String(err) },
          "live: lazy hydration failed",
        );
      }
    })();
  });

  return offEvent;
}

