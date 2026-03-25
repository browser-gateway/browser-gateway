import type { BackendState } from "../types.js";

interface CooldownConfig {
  defaultMs: number;
  failureThreshold: number;
  minRequestVolume: number;
}

export class CooldownTracker {
  private config: CooldownConfig;
  private windowMs = 60_000;

  private failures: Map<string, number[]> = new Map();
  private successes: Map<string, number[]> = new Map();

  constructor(config: CooldownConfig) {
    this.config = config;
  }

  recordFailure(backend: BackendState): void {
    const now = Date.now();
    const fails = this.getWindow(this.failures, backend.id, now);
    fails.push(now);

    backend.failureCount++;
    backend.lastFailure = now;

    const successCount = this.getWindow(
      this.successes,
      backend.id,
      now
    ).length;
    const totalCount = fails.length + successCount;

    if (totalCount < this.config.minRequestVolume) return;

    const failureRate = fails.length / totalCount;
    const threshold = this.config.failureThreshold;

    if (failureRate >= threshold) {
      backend.cooldownUntil = now + this.config.defaultMs;
      backend.healthy = false;
    }
  }

  recordSuccess(backend: BackendState): void {
    const now = Date.now();
    const wins = this.getWindow(this.successes, backend.id, now);
    wins.push(now);

    backend.successCount++;

    if (backend.cooldownUntil && now >= backend.cooldownUntil) {
      backend.cooldownUntil = null;
      backend.healthy = true;
    }
  }

  isInCooldown(backend: BackendState): boolean {
    if (!backend.cooldownUntil) return false;

    if (Date.now() >= backend.cooldownUntil) {
      backend.cooldownUntil = null;
      backend.healthy = true;
      return false;
    }

    return true;
  }

  private getWindow(
    store: Map<string, number[]>,
    backendId: string,
    now: number
  ): number[] {
    let entries = store.get(backendId);
    if (!entries) {
      entries = [];
      store.set(backendId, entries);
    }

    const cutoff = now - this.windowMs;
    const filtered = entries.filter((t) => t > cutoff);
    store.set(backendId, filtered);
    return filtered;
  }
}
