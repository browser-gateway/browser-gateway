import { readdirSync, existsSync } from "node:fs";
import type { Logger } from "pino";
import { ReplayStore } from "./store.js";

export interface ReplayRetentionOpts {
  store: ReplayStore;
  storePath: string;
  retentionDays: number;
  incompleteGraceMs?: number;
  logger: Logger;
  now?: () => number;
}

const DEFAULT_INCOMPLETE_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class ReplayRetention {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: ReplayRetentionOpts) {}

  start(intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.runOnce();
      } catch (err) {
        this.opts.logger.error({ err: err instanceof Error ? err.message : String(err) }, "replay retention sweep failed");
      }
    }, intervalMs);
    if (typeof this.timer === "object" && this.timer !== null && "unref" in this.timer) {
      (this.timer as { unref(): void }).unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  runOnce(): { purged: string[]; kept: string[] } {
    const { store, storePath, retentionDays, logger } = this.opts;
    const now = this.opts.now ?? Date.now;
    const graceMs = this.opts.incompleteGraceMs ?? DEFAULT_INCOMPLETE_GRACE_MS;

    if (retentionDays === 0) {
      return { purged: [], kept: store.exists() ? readdirSync(storePath) : [] };
    }
    if (!existsSync(storePath)) {
      return { purged: [], kept: [] };
    }

    const cutoffMs = now() - retentionDays * 24 * 60 * 60 * 1000;
    const purged: string[] = [];
    const kept: string[] = [];

    for (const sessionId of readdirSync(storePath)) {
      const meta = store.get(sessionId);
      if (!meta) {
        kept.push(sessionId);
        continue;
      }
      const endedAt = meta.endedAt ?? meta.startedAt + graceMs;
      const isCompleteAndOld = meta.complete && endedAt < cutoffMs;
      const isIncompleteAndAged = !meta.complete && now() - meta.startedAt > graceMs && endedAt < cutoffMs;
      if (isCompleteAndOld || isIncompleteAndAged) {
        store.delete(sessionId);
        purged.push(sessionId);
        logger.info({ sessionId, complete: meta.complete }, "replay: purged");
      } else {
        kept.push(sessionId);
      }
    }
    return { purged, kept };
  }
}
