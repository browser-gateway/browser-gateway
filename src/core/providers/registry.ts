import type { ProviderConfig, ProviderState } from "../types.js";

export class ProviderRegistry {
  private providers: Map<string, ProviderState> = new Map();

  register(id: string, config: ProviderConfig): void {
    this.providers.set(id, {
      id,
      config,
      active: 0,
      healthy: true,
      cooldownUntil: null,
      failureCount: 0,
      successCount: 0,
      lastFailure: null,
      avgLatencyMs: 0,
      totalConnections: 0,
    });
  }

  get(id: string): ProviderState | undefined {
    return this.providers.get(id);
  }

  getAll(): ProviderState[] {
    return [...this.providers.values()];
  }

  getAllSortedByPriority(): ProviderState[] {
    return this.getAll().sort(
      (a, b) => a.config.priority - b.config.priority
    );
  }

  remove(id: string): boolean {
    return this.providers.delete(id);
  }

  size(): number {
    return this.providers.size;
  }
}
