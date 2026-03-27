import type { ProviderState } from "../types.js";

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

  recordFailure(provider: ProviderState): void {
    const now = Date.now();
    const fails = this.getWindow(this.failures, provider.id, now);
    fails.push(now);

    provider.failureCount++;
    provider.lastFailure = now;

    const successCount = this.getWindow(
      this.successes,
      provider.id,
      now
    ).length;
    const totalCount = fails.length + successCount;

    if (totalCount < this.config.minRequestVolume) return;

    const failureRate = fails.length / totalCount;
    const threshold = this.config.failureThreshold;

    if (failureRate >= threshold) {
      provider.cooldownUntil = now + this.config.defaultMs;
      provider.healthy = false;
    }
  }

  recordSuccess(provider: ProviderState): void {
    const now = Date.now();
    const wins = this.getWindow(this.successes, provider.id, now);
    wins.push(now);

    provider.successCount++;

    if (provider.cooldownUntil && now >= provider.cooldownUntil) {
      provider.cooldownUntil = null;
      provider.healthy = true;
    }
  }

  isInCooldown(provider: ProviderState): boolean {
    if (!provider.cooldownUntil) return false;

    if (Date.now() >= provider.cooldownUntil) {
      provider.cooldownUntil = null;
      provider.healthy = true;
      return false;
    }

    return true;
  }

  private getWindow(
    store: Map<string, number[]>,
    providerId: string,
    now: number
  ): number[] {
    let entries = store.get(providerId);
    if (!entries) {
      entries = [];
      store.set(providerId, entries);
    }

    const cutoff = now - this.windowMs;
    const filtered = entries.filter((t) => t > cutoff);
    store.set(providerId, filtered);
    return filtered;
  }
}
