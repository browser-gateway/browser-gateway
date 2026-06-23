import type { ProviderConfig, ProviderState } from "../types.js";
import {
  probeProviderCapabilities,
  type ProviderCapabilities,
} from "./capabilities.js";

export type CapabilityProbeStatus = "pending" | "probing" | "ready" | "failed";

export interface CapabilityRecord {
  status: CapabilityProbeStatus;
  capabilities: ProviderCapabilities | null;
}

export interface RegisterOptions {
  /** Run the capability probe after register. Default true. */
  autoProbe?: boolean;
}

export class ProviderRegistry {
  private providers: Map<string, ProviderState> = new Map();
  private capabilities: Map<string, CapabilityRecord> = new Map();
  private inflightProbes: Map<string, Promise<void>> = new Map();

  register(id: string, config: ProviderConfig, opts: RegisterOptions = {}): void {
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
    this.capabilities.set(id, { status: "pending", capabilities: null });
    if (opts.autoProbe !== false) {
      void this.probe(id);
    }
  }

  /**
   * Run (or re-run) the capability probe for a provider. Idempotent — concurrent
   * calls return the same in-flight Promise.
   */
  probe(id: string): Promise<void> {
    const existing = this.inflightProbes.get(id);
    if (existing) return existing;

    const provider = this.providers.get(id);
    if (!provider) return Promise.resolve();

    this.capabilities.set(id, {
      status: "probing",
      capabilities: this.capabilities.get(id)?.capabilities ?? null,
    });

    const run = (async () => {
      try {
        const caps = await probeProviderCapabilities(provider.config.url);
        const allUnknown =
          caps.browserCookies === "unknown" &&
          caps.targetCreate === "unknown" &&
          caps.fetchInterception === "unknown";
        this.capabilities.set(id, {
          status: allUnknown ? "failed" : "ready",
          capabilities: caps,
        });
      } catch {
        this.capabilities.set(id, { status: "failed", capabilities: null });
      } finally {
        this.inflightProbes.delete(id);
      }
    })();

    this.inflightProbes.set(id, run);
    return run;
  }

  getCapabilityRecord(id: string): CapabilityRecord | undefined {
    return this.capabilities.get(id);
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
    this.capabilities.delete(id);
    this.inflightProbes.delete(id);
    return this.providers.delete(id);
  }

  size(): number {
    return this.providers.size;
  }
}
