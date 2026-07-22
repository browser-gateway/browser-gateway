import type { ProviderConfig, ProviderState } from "../types.js";

/**
 * Given a provider's config and the caller's requested profile, decide whether
 * that provider slot is eligible to serve the request. Three provider roles:
 *   - pinned (`profile: "X"`): serves only profile X
 *   - multi-profile (`multiProfile: true`): serves any profile including none
 *   - stateless-only (neither): serves only stateless (no `?profile=`) traffic
 */
export function isEligibleForProfile(
  config: ProviderConfig,
  requestedProfile: string | null | undefined,
): boolean {
  if (config.multiProfile) return true;
  if (requestedProfile == null) return config.profile == null;
  return config.profile === requestedProfile;
}

/**
 * Profile eligibility with vendor detection applied: a detected browserserve
 * provider serves any profile (each session is a fresh isolated browser), in
 * addition to the static config rules (`multiProfile`, `profile` pin).
 */
export function isEligibleProviderForProfile(
  provider: ProviderState,
  requestedProfile: string | null | undefined,
): boolean {
  if (provider.detectedKind === "browserserve") return true;
  return isEligibleForProfile(provider.config, requestedProfile);
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
