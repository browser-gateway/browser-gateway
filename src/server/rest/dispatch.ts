/**
 * Single dispatcher for the three REST action handlers (screenshot, content,
 * scrape). When the request body has `profile: "..."`, we run the action via
 * `withProfilePage` (one-shot, no retries, lifecycle.acquire/inject/commit
 * around it). Otherwise we use the default pooled `withBrowserPage` which
 * reuses sessions for throughput.
 *
 * Centralizing this prevents the three handlers from diverging on profile
 * handling (e.g. one forgetting to disable retries, another forgetting the
 * disabled-feature 400).
 */
import type { Page } from "playwright-core";
import type { Logger } from "pino";
import type { Gateway } from "../../core/index.js";
import type { SessionPool } from "../../core/pool/index.js";
import type { ProfileLifecycle } from "../profile/lifecycle.js";
import { withBrowserPage } from "./executor.js";
import type { PageOptions, PageResult } from "./executor.js";
import { withProfilePage } from "./profile-executor.js";
import { RestApiError } from "./schemas.js";

export interface DispatchDeps {
  pool: SessionPool;
  gateway: Gateway;
  logger: Logger;
  profileLifecycle?: ProfileLifecycle;
}

/**
 * If `profileId` is set, route through the profile-pinned executor; otherwise
 * use the pooled executor. `options.provider`, when set, pins the request to
 * one specific backend (no failover) — validated here so the failure modes
 * map to clean HTTP errors instead of leaking out of the pool.
 */
export async function dispatchPageAction<T>(
  deps: DispatchDeps,
  profileId: string | undefined,
  options: PageOptions,
  action: (page: Page) => Promise<T>,
  runOpts: { tolerateGotoTimeout?: boolean } = {},
): Promise<PageResult<T>> {
  if (options.provider) {
    validateProviderPin(deps.gateway, options.provider, profileId !== undefined);
  }

  if (profileId) {
    if (!deps.profileLifecycle) {
      throw new RestApiError(
        400,
        "profile field used but profiles are not enabled on this gateway — set profiles.enabled: true in gateway.yml and configure BG_ENCRYPTION_KEY",
      );
    }
    return withProfilePage(
      { gateway: deps.gateway, lifecycle: deps.profileLifecycle, logger: deps.logger },
      profileId,
      { ...options, retries: 0 },
      action,
      runOpts,
    );
  }
  return withBrowserPage(deps.pool, deps.logger, options, action, runOpts);
}

/**
 * Validate `?provider=<id>` against the registry before any work starts:
 *
 *   - exists in gateway.yml?
 *   - if `profile` is also set, does the provider support `browserCookies`?
 *
 * Throws a 400 with a helpful message instead of letting the failure surface
 * mid-execution as a generic CDP error.
 */
function validateProviderPin(
  gateway: DispatchDeps["gateway"],
  providerId: string,
  withProfile: boolean,
): void {
  const provider = gateway.registry.get(providerId);
  if (!provider) {
    const available = gateway.registry.getAll().map((p) => p.id).join(", ") || "(none)";
    throw new RestApiError(
      400,
      `Provider '${providerId}' is not configured. Available providers: ${available}`,
    );
  }
  if (withProfile) {
    const record = gateway.registry.getCapabilityRecord(providerId);
    const cookies = record?.capabilities?.browserCookies;
    if (cookies === "unsupported") {
      throw new RestApiError(
        400,
        `Provider '${providerId}' cannot serve profile requests — browserCookies is unsupported on this backend.`,
      );
    }
  }
}
