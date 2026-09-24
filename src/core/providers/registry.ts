import type { ProviderConfig, ProviderState } from "../types.js";
import {
  probeProviderCapabilities,
  type ProviderCapabilities,
} from "./capabilities.js";

/**
 * Read-only view of provider state that the selector needs. Any store —
 * the built-in in-memory ProviderRegistry, or an adapter over an external
 * store (D1, KV, Postgres) — can satisfy this by producing hydrated
 * ProviderState objects.
 */
export interface ProviderStore {
  get(id: string): ProviderState | undefined;
  getAllSortedByPriority(): ProviderState[];
}

/** Bounded re-probe of a failed/warming provider: 2s, 4s, 8s, 16s, 32s. */
const MAX_REPROBE_ATTEMPTS = 5;
const REPROBE_BASE_MS = 2_000;

export type CapabilityProbeStatus = "pending" | "probing" | "ready" | "failed";

export interface CapabilityRecord {
  status: CapabilityProbeStatus;
  capabilities: ProviderCapabilities | null;
}

export interface RegisterOptions {
  /** Run the capability probe after register. Default true. */
  autoProbe?: boolean;
}

export class ProviderRegistry implements ProviderStore {
  private providers: Map<string, ProviderState> = new Map();
  private disabled: Map<string, ProviderState> = new Map();
  private capabilities: Map<string, CapabilityRecord> = new Map();
  private inflightProbes: Map<string, Promise<void>> = new Map();
  private reprobeAttempts: Map<string, number> = new Map();

  register(id: string, config: ProviderConfig, opts: RegisterOptions = {}): void {
    this.disabled.delete(id);
    this.providers.set(id, freshState(id, config));
    this.capabilities.set(id, { status: "pending", capabilities: null });
    if (opts.autoProbe !== false) {
      void this.probe(id);
    }
  }

  /**
   * Holds a provider out of routing. Its state survives so sessions already
   * running on it can still release their slot, and re-enabling restores it.
   */
  disable(id: string, config: ProviderConfig): void {
    const state = this.providers.get(id) ?? this.disabled.get(id) ?? freshState(id, config);
    state.config = config;
    this.providers.delete(id);
    this.inflightProbes.delete(id);
    this.reprobeAttempts.delete(id);
    this.disabled.set(id, state);
  }

  /** Returns a disabled provider to routing, keeping its live slot counts. */
  enable(id: string, config: ProviderConfig): void {
    const state = this.disabled.get(id);
    if (!state) {
      const live = this.providers.get(id);
      if (live) live.config = config;
      else this.register(id, config);
      return;
    }
    this.disabled.delete(id);
    state.config = config;
    this.providers.set(id, state);
    if (!this.capabilities.has(id)) this.capabilities.set(id, { status: "pending", capabilities: null });
    void this.probe(id);
  }

  /** Looks a provider up whether or not it is enabled. Routing must use `get`. */
  getIncludingDisabled(id: string): ProviderState | undefined {
    return this.providers.get(id) ?? this.disabled.get(id);
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
        provider.detectedKind = caps.providerKind === "browserserve" ? "browserserve" : null;
        provider.discoveredMaxConcurrent = caps.advertisedMaxConcurrent;
        if (allUnknown) {
          this.scheduleReprobe(id);
        } else {
          this.reprobeAttempts.delete(id);
        }
      } catch {
        this.capabilities.set(id, { status: "failed", capabilities: null });
        this.scheduleReprobe(id);
      } finally {
        this.inflightProbes.delete(id);
      }
    })();

    this.inflightProbes.set(id, run);
    return run;
  }

  /**
   * Re-runs a failed probe with exponential backoff, up to a bounded number of
   * attempts. A provider that is still warming (its `/json/version` returns 503)
   * probes as all-unknown; this lets it be detected once it is ready instead of
   * staying `detectedKind: null` forever.
   */
  private scheduleReprobe(id: string): void {
    const attempts = this.reprobeAttempts.get(id) ?? 0;
    if (attempts >= MAX_REPROBE_ATTEMPTS) return;
    this.reprobeAttempts.set(id, attempts + 1);
    const delayMs = REPROBE_BASE_MS * 2 ** attempts;
    const timer = setTimeout(() => {
      if (this.providers.has(id)) void this.probe(id);
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  /**
   * Awaits every provider's capability status to leave `pending`/`probing`,
   * or the deadline. Callers use this at boot to avoid the race where a
   * client connects for `?profile=X` before the capability probe has
   * classified the provider as browserserve, which would cause the first
   * request to 503 unless the provider is statically pinned. Bounded — also
   * awaits scheduled re-probes (used when the upstream was slow to start).
   */
  async awaitInitialProbes(opts: { maxWaitMs?: number } = {}): Promise<void> {
    const deadline = Date.now() + (opts.maxWaitMs ?? 5_000);
    while (Date.now() < deadline) {
      const inflight = [...this.inflightProbes.values()];
      if (inflight.length > 0) {
        const remaining = Math.max(0, deadline - Date.now());
        await Promise.race([
          Promise.allSettled(inflight),
          new Promise<void>((resolve) => setTimeout(resolve, remaining)),
        ]);
      }
      const anyProbing = [...this.providers.keys()].some((id) => {
        const status = this.capabilities.get(id)?.status;
        return status === "pending" || status === "probing";
      });
      if (!anyProbing && this.inflightProbes.size === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  getCapabilityRecord(id: string): CapabilityRecord | undefined {
    return this.capabilities.get(id);
  }

  setCapabilities(id: string, capabilities: import("./capabilities.js").ProviderCapabilities): void {
    this.capabilities.set(id, { status: "ready", capabilities });
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
    const wasDisabled = this.disabled.delete(id);
    return this.providers.delete(id) || wasDisabled;
  }

  size(): number {
    return this.providers.size;
  }
}

function freshState(id: string, config: ProviderConfig): ProviderState {
  return {
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
    detectedKind: null,
    discoveredMaxConcurrent: null,
  };
}
