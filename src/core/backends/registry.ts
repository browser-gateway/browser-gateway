import type { BackendConfig, BackendState } from "../types.js";

export class BackendRegistry {
  private backends: Map<string, BackendState> = new Map();

  register(id: string, config: BackendConfig): void {
    this.backends.set(id, {
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

  get(id: string): BackendState | undefined {
    return this.backends.get(id);
  }

  getAll(): BackendState[] {
    return [...this.backends.values()];
  }

  getAllSortedByPriority(): BackendState[] {
    return this.getAll().sort(
      (a, b) => a.config.priority - b.config.priority
    );
  }

  size(): number {
    return this.backends.size;
  }
}
