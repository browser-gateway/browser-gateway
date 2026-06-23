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

/** Installs a top-level frameNavigated listener that lazily injects storage. Returns teardown. */
export function installLazyHydration(deps: LazyHydrationDeps): () => void {
  const evalTimeout = deps.evaluateTimeoutMs ?? 3_000;

  const offEvent = deps.cdp.on((event) => {
    if (event.method !== "Page.frameNavigated") return;
    const p = event.params as { frame?: { url?: string; parentId?: string } };
    if (!p.frame || p.frame.parentId) return;
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

