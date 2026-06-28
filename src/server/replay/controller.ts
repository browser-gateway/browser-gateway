import type { Logger } from "pino";
import type { ReplayConfig } from "../../core/types.js";
import type { ProviderRegistry } from "../../core/providers/registry.js";
import { ReplayCapture } from "./capture.js";

export interface ReplayControllerOpts {
  storePath: string;
  config: ReplayConfig;
  registry: ProviderRegistry;
  logger: Logger;
}

export class ReplayController {
  private readonly active = new Map<string, ReplayCapture>();

  constructor(private readonly opts: ReplayControllerOpts) {}

  onSessionStart(input: {
    sessionId: string;
    providerId: string;
    providerWsUrl: string;
    profileId?: string;
  }): void {
    if (!this.opts.config.enabled) return;

    const caps = this.opts.registry.getCapabilityRecord(input.providerId)?.capabilities;
    if (!caps || caps.pageScreencast !== "supported") {
      this.opts.logger.info(
        { sessionId: input.sessionId, providerId: input.providerId },
        "replay: provider does not support page screencast, skipping capture",
      );
      return;
    }

    const capture = new ReplayCapture({
      sessionId: input.sessionId,
      providerId: input.providerId,
      providerWsUrl: input.providerWsUrl,
      profileId: input.profileId,
      storePath: this.opts.storePath,
      config: this.opts.config,
      logger: this.opts.logger,
    });
    this.active.set(input.sessionId, capture);

    void capture.start().catch((err) => {
      this.opts.logger.warn(
        { sessionId: input.sessionId, err: err instanceof Error ? err.message : String(err) },
        "replay: capture start failed",
      );
      this.active.delete(input.sessionId);
    });
  }

  onSessionEnd(sessionId: string): void {
    const capture = this.active.get(sessionId);
    if (!capture) return;
    this.active.delete(sessionId);
    void capture.finish().catch((err) => {
      this.opts.logger.warn(
        { sessionId, err: err instanceof Error ? err.message : String(err) },
        "replay: capture finish failed",
      );
    });
  }

  activeCount(): number {
    return this.active.size;
  }

  async shutdown(): Promise<void> {
    const all = Array.from(this.active.values());
    this.active.clear();
    await Promise.allSettled(all.map((c) => c.finish()));
  }
}
