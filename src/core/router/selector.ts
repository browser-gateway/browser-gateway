import type { ProviderConfig, ProviderState } from "../types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { CooldownTracker } from "../tracking/cooldown.js";

export type Strategy =
  | "priority-chain"
  | "round-robin"
  | "least-connections"
  | "latency-optimized"
  | "weighted";

export interface SelectOptions {
  strategy?: Strategy;
  /**
   * When set, restrict the candidate list to exactly this provider id.
   * Returns `[provider]` when the pinned provider is healthy + has a free slot,
   * `[]` when it's missing / in cooldown / saturated. All other selection
   * strategies are bypassed — the caller asked for one specific provider,
   * not a routing decision.
   */
  targetProviderId?: string;
  /**
   * Match against per-provider profile pins. `null`/`undefined` means the
   * caller is not requesting a profile (stateless). A string means the caller
   * is requesting `?profile=<value>`.
   */
  profileId?: string | null;
}

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

export class ProviderSelector {
  private roundRobinIndex = 0;
  private weightedState: Map<string, number> = new Map();

  constructor(
    private registry: ProviderRegistry,
    private cooldown: CooldownTracker,
    private defaultStrategy: Strategy
  ) {}

  getCandidates(opts: SelectOptions = {}): ProviderState[] {
    if (opts.targetProviderId !== undefined) {
      const pinned = this.registry.get(opts.targetProviderId);
      if (!pinned) return [];
      if (this.cooldown.isInCooldown(pinned)) return [];
      const max = pinned.config.limits?.maxConcurrent;
      if (max && pinned.active >= max) return [];
      if (!isEligibleForProfile(pinned.config, opts.profileId)) return [];
      return [pinned];
    }

    const all = this.registry.getAllSortedByPriority();

    const available = all.filter((b) => {
      if (this.cooldown.isInCooldown(b)) return false;

      const max = b.config.limits?.maxConcurrent;
      if (max && b.active >= max) return false;

      if (!isEligibleForProfile(b.config, opts.profileId)) return false;

      return true;
    });

    if (available.length === 0) return [];

    const activeStrategy = opts.strategy ?? this.defaultStrategy;
    return this.applyStrategy(available, activeStrategy);
  }

  private applyStrategy(
    candidates: ProviderState[],
    strategy: Strategy
  ): ProviderState[] {
    switch (strategy) {
      case "priority-chain":
        return candidates;

      case "round-robin": {
        const index = this.roundRobinIndex % candidates.length;
        this.roundRobinIndex++;
        const selected = candidates[index];
        return [selected, ...candidates.filter((c) => c.id !== selected.id)];
      }

      case "least-connections": {
        return [...candidates].sort((a, b) => a.active - b.active);
      }

      case "latency-optimized": {
        return [...candidates].sort((a, b) => {
          if (a.avgLatencyMs === 0 && b.avgLatencyMs === 0) return 0;
          if (a.avgLatencyMs === 0) return 1;
          if (b.avgLatencyMs === 0) return -1;
          return a.avgLatencyMs - b.avgLatencyMs;
        });
      }

      case "weighted": {
        return this.smoothWeightedRoundRobin(candidates);
      }

      default:
        return candidates;
    }
  }

  // Nginx-style smooth weighted round-robin
  // Produces even distribution: A(5) B(3) C(2) → AABABCABCA (not AAAAABBBCC)
  private smoothWeightedRoundRobin(candidates: ProviderState[]): ProviderState[] {
    const totalWeight = candidates.reduce((sum, c) => sum + (c.config.weight ?? 1), 0);

    // Add configured weight to each candidate's current weight
    for (const c of candidates) {
      const current = this.weightedState.get(c.id) ?? 0;
      this.weightedState.set(c.id, current + (c.config.weight ?? 1));
    }

    // Pick the candidate with highest current weight
    let best = candidates[0];
    let bestWeight = this.weightedState.get(best.id) ?? 0;

    for (const c of candidates) {
      const w = this.weightedState.get(c.id) ?? 0;
      if (w > bestWeight) {
        best = c;
        bestWeight = w;
      }
    }

    // Subtract total weight from the selected candidate
    this.weightedState.set(best.id, bestWeight - totalWeight);

    // Return selected first, others as fallback
    return [best, ...candidates.filter((c) => c.id !== best.id)];
  }
}
