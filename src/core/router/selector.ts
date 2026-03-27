import type { ProviderState } from "../types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { CooldownTracker } from "../tracking/cooldown.js";

export type Strategy =
  | "priority-chain"
  | "round-robin"
  | "least-connections"
  | "latency-optimized";

export class ProviderSelector {
  private roundRobinIndex = 0;

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

      default:
        return candidates;
    }
  }
}
