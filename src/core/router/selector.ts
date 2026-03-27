import type { ProviderState } from "../types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { CooldownTracker } from "../tracking/cooldown.js";

export type Strategy =
  | "priority-chain"
  | "round-robin"
  | "least-connections"
  | "latency-optimized"
  | "weighted";

export class ProviderSelector {
  private roundRobinIndex = 0;
  private weightedState: Map<string, number> = new Map();

  constructor(
    private registry: ProviderRegistry,
    private cooldown: CooldownTracker,
    private defaultStrategy: Strategy
  ) {}

  getCandidates(strategy?: Strategy): ProviderState[] {
    const all = this.registry.getAllSortedByPriority();

    const available = all.filter((b) => {
      if (this.cooldown.isInCooldown(b)) return false;

      const max = b.config.limits?.maxConcurrent;
      if (max && b.active >= max) return false;

      return true;
    });

    if (available.length === 0) return [];

    const activeStrategy = strategy ?? this.defaultStrategy;
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
