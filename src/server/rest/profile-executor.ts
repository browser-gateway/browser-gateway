/**
 * `withProfilePage` — REST executor variant that pins a request to a profile id.
 *
 * The default `withBrowserPage` reuses pooled browser sessions. That's fine when
 * requests are stateless, but for profile-pinned requests we MUST start from a
 * fresh browser state so the previous request's cookies don't leak in, and we
 * MUST capture the state back to disk on success. Reusing the pool would do
 * neither cleanly.
 *
 * Flow:
 *   1. ProfileLifecycle.acquire(profileId)               — lock + read cookies
 *   2. For each candidate provider:
 *        a. acquireSlot
 *        b. resolve provider WS URL
 *        c. lifecycle.inject(acquired, wsUrl)            — push cookies in via transient CDP
 *        d. chromium.connectOverCDP(wsUrl)               — playwright session
 *        e. open page, run user's action
 *        f. lifecycle.commit(acquired, wsUrl)            — capture latest, save, release lock
 *        g. releaseSlot, disconnect playwright, return result
 *   3. If all providers fail: lifecycle.release (no save), throw 503.
 *
 * Retries: ONE attempt only when a profile is set. Retrying could double-commit
 * state across providers and corrupt the blob — explicit ?profile= disables the
 * automatic retry loop.
 */
import type { Page } from "playwright-core";
import { chromium } from "playwright-core";
import type { Logger } from "pino";
import type { Gateway } from "../../core/gateway.js";
import { resolveWsUrl } from "../../core/providers/cdp.js";
import { ProfileLifecycle, LifecycleError } from "../profile/lifecycle.js";
import { RestApiError } from "./schemas.js";
import type { PageOptions, PageResult } from "./executor.js";
import { runPageAction } from "./page-runner.js";

export interface WithProfilePageDeps {
  gateway: Gateway;
  lifecycle: ProfileLifecycle;
  logger: Logger;
}

export async function withProfilePage<T>(
  deps: WithProfilePageDeps,
  profileId: string,
  options: PageOptions,
  action: (page: Page) => Promise<T>,
): Promise<PageResult<T>> {
  const { gateway, lifecycle, logger } = deps;
  const startTime = Date.now();

  // 1) Acquire the profile lock + read existing cookies.
  let acquired;
  try {
    acquired = await lifecycle.acquire(profileId);
  } catch (err) {
    if (err instanceof LifecycleError) {
      if (err.reason === "INVALID_ID") {
        throw new RestApiError(400, err.message);
      }
      if (err.reason === "LOCK_HELD") {
        throw new RestApiError(409, `Profile "${profileId}" is in use by another session`);
      }
      if (err.reason === "DECRYPT_FAILED") {
        throw new RestApiError(500, `Profile "${profileId}" could not be decrypted — wrong BG_ENCRYPTION_KEY?`);
      }
      if (err.reason === "UNKNOWN_DEK_VERSION") {
        throw new RestApiError(500, `Profile "${profileId}" was encrypted with an unknown key version`);
      }
    }
    throw new RestApiError(500, `Failed to acquire profile "${profileId}": ${(err as Error).message}`);
  }

  const sessionId = `rest-profile-${profileId}-${Date.now()}`;
  const candidates = gateway.selectProviderWithFallbacks();

  if (candidates.length === 0) {
    await lifecycle.release(acquired);
    throw new RestApiError(503, "No providers available");
  }

  let lastError: Error | null = null;

  for (const provider of candidates) {
    if (options.signal?.aborted) {
      await lifecycle.release(acquired);
      throw new RestApiError(499, "Client closed request");
    }

    if (!gateway.acquireSlot(provider.id, sessionId)) {
      logger.debug(
        { profileId, providerId: provider.id },
        "rest profile: provider at capacity, trying next",
      );
      continue;
    }

    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
    try {
      const wsUrl = await resolveWsUrl(provider.config.url);

      // 2c) inject cookies via transient CDP before the playwright session opens.
      // If inject fails on this provider we try the next one.
      try {
        await lifecycle.inject(acquired, wsUrl);
      } catch (err) {
        logger.warn(
          { profileId, providerId: provider.id, error: (err as Error).message },
          "rest profile: inject failed, trying next provider",
        );
        gateway.releaseSlot(sessionId, provider.id);
        gateway.recordFailure(provider.id);
        lastError = err as Error;
        continue;
      }

      browser = await chromium.connectOverCDP(wsUrl, { timeout: options.timeout ?? 30000 });
      const contexts = browser.contexts();
      const context = contexts[0] ?? (await browser.newContext());
      const page = await context.newPage();

      const run = await runPageAction(page, options, action);
      const result: PageResult<T> = {
        data: run.data,
        statusCode: run.statusCode,
        resolvedUrl: run.resolvedUrl,
        timings: {
          total: Date.now() - startTime,
          navigation: run.navigationMs,
          action: run.actionMs,
        },
        attempt: 1,
      };

      await page.close().catch(() => {});

      // 2f) Commit the latest state. We do this BEFORE disconnecting so the
      // capture sees the post-action cookies. commit() handles its own retry
      // and lock release internally and never throws — it just logs.
      await lifecycle.commit(acquired, wsUrl);

      gateway.recordSuccess(provider.id, Date.now() - startTime);
      return result;
    } catch (err) {
      lastError = err as Error;
      logger.info(
        { profileId, providerId: provider.id, error: lastError.message.slice(0, 120) },
        "rest profile: action failed on this provider",
      );
      gateway.recordFailure(provider.id);
      // The action failed mid-stream. Release without commit so we don't save
      // a half-finished state on top of the existing blob.
      await lifecycle.release(acquired);
      // Since we already released the lifecycle lock, set acquired to a no-op
      // sentinel for the loop continuation.
      acquired = null as unknown as typeof acquired;
      break;
    } finally {
      if (browser) await browser.close().catch(() => {});
      gateway.releaseSlot(sessionId, provider.id);
    }
  }

  // No provider succeeded.
  if (acquired) {
    await lifecycle.release(acquired);
  }

  const msg = lastError?.message ?? "Unknown error";
  if (msg.includes("Timeout") || msg.includes("timeout")) {
    throw new RestApiError(408, `Navigation timeout: ${msg}`);
  }
  throw new RestApiError(500, `Profile-pinned request failed: ${msg}`);
}
