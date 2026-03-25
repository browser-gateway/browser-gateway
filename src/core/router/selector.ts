import type { BackendState } from "../types.js";
import type { BackendRegistry } from "../backends/registry.js";
import type { CooldownTracker } from "../tracking/cooldown.js";

export type Strategy = "priority-chain" | "round-robin" | "least-connections";

export class BackendSelector {
  private roundRobinIndex = 0;

  constructor(
    private registry: BackendRegistry,
    private cooldown: CooldownTracker,
    private defaultStrategy: Strategy
  ) {}

  getCandidates(strategy?: Strategy): BackendState[] {
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
    candidates: BackendState[],
    strategy: Strategy
  ): BackendState[] {
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
        const sorted = [...candidates].sort((a, b) => a.active - b.active);
        return sorted;
      }

      default:
        return candidates;
    }
  }
}
