import type { ProviderConfig, ProviderState } from "../types.js";

/**
 * Config-shape check: does the provider's `profile` pin admit the requested profile?
 * An unpinned provider serves every session; a pinned one only its own profile.
 */
export function isEligibleForProfile(
  config: ProviderConfig,
  requestedProfile: string | null | undefined,
): boolean {
  if (config.multiProfile || config.profile == null) return true;
  return config.profile === requestedProfile;
}

/**
 * Runtime profile-eligibility. Any provider may load and save any profile unless it
 * is pinned to a different one. Mixing profiles on a reused browser is caught at
 * session start by the profile marker check, not here.
 */
export function isEligibleProviderForProfile(
  provider: Pick<ProviderState, "detectedKind"> & { config: Pick<ProviderState["config"], "profile"> },
  requestedProfile: string | null | undefined,
): boolean {
  if (provider.detectedKind === "browserserve" || provider.config.profile == null) return true;
  return provider.config.profile === requestedProfile;
}

/**
 * The concurrency ceiling actually enforced for a provider: explicit
 * `limits.maxConcurrent` config always wins; otherwise the capacity the
 * provider advertised (browserserve auto-capacity); otherwise unlimited.
 */
export function effectiveMaxConcurrent(provider: ProviderState): number | undefined {
  return provider.config.limits?.maxConcurrent ?? provider.discoveredMaxConcurrent ?? undefined;
}

/** True when the provider has a free slot under its effective ceiling. */
export function hasFreeSlot(provider: ProviderState): boolean {
  const max = effectiveMaxConcurrent(provider);
  return !max || provider.active < max;
}
