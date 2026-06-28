/**
 * Retention sweep contract — older completed sessions get purged, fresh ones
 * stay, incomplete sessions get a 24h grace period before they're eligible,
 * `retentionDays: 0` means keep-forever.
 *
 * Uses an injected clock so the time math is deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ReplayStore } from "../../../src/server/replay/store.js";
import { ReplayRetention } from "../../../src/server/replay/retention.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let dir: string;
let store: ReplayStore;
const logger = pino({ level: "silent" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bg-replay-ret-"));
  store = new ReplayStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(opts: {
  id: string;
  startedAt: number;
  endedAt?: number;
}): void {
  const sd = join(dir, opts.id);
  mkdirSync(sd, { recursive: true });
  writeFileSync(
    join(sd, "meta.json"),
    JSON.stringify({
      sessionId: opts.id,
      providerId: "browserless",
      startedAt: opts.startedAt,
      endedAt: opts.endedAt,
      frameCount: 0,
      sizeBytes: 0,
      complete: opts.endedAt !== undefined,
    }),
  );
  if (opts.endedAt !== undefined) {
    writeFileSync(
      join(sd, "complete.json"),
      JSON.stringify({ endedAt: opts.endedAt, frameCount: 0, sizeBytes: 0 }),
    );
  }
}

describe("ReplayRetention.runOnce", () => {
  const NOW = 100 * DAY;

  it("does nothing when the store doesn't exist", () => {
    rmSync(dir, { recursive: true, force: true });
    const r = new ReplayRetention({ store, storePath: dir, retentionDays: 7, logger, now: () => NOW });
    expect(r.runOnce()).toEqual({ purged: [], kept: [] });
  });

  it("retentionDays:0 keeps everything forever", () => {
    seed({ id: "ancient", startedAt: 0, endedAt: 1 });
    seed({ id: "fresh", startedAt: NOW - HOUR, endedAt: NOW - 1 });
    const r = new ReplayRetention({ store, storePath: dir, retentionDays: 0, logger, now: () => NOW });
    const result = r.runOnce();
    expect(result.purged).toEqual([]);
    expect(result.kept.sort()).toEqual(["ancient", "fresh"]);
  });

  it("purges completed sessions older than retention horizon", () => {
    seed({ id: "old-done", startedAt: NOW - 10 * DAY, endedAt: NOW - 10 * DAY + HOUR });
    seed({ id: "recent-done", startedAt: NOW - 2 * DAY, endedAt: NOW - 2 * DAY + HOUR });
    const r = new ReplayRetention({ store, storePath: dir, retentionDays: 7, logger, now: () => NOW });
    const result = r.runOnce();
    expect(result.purged).toEqual(["old-done"]);
    expect(result.kept).toEqual(["recent-done"]);
    expect(existsSync(join(dir, "old-done"))).toBe(false);
    expect(existsSync(join(dir, "recent-done"))).toBe(true);
  });

  it("keeps incomplete sessions within the 24h grace window", () => {
    seed({ id: "mid-flight", startedAt: NOW - 2 * HOUR /* no endedAt */ });
    const r = new ReplayRetention({ store, storePath: dir, retentionDays: 7, logger, now: () => NOW });
    const result = r.runOnce();
    expect(result.kept).toEqual(["mid-flight"]);
    expect(existsSync(join(dir, "mid-flight"))).toBe(true);
  });

  it("purges incomplete sessions older than grace + retention", () => {
    // 10 days old, never completed, retention=7
    seed({ id: "abandoned", startedAt: NOW - 10 * DAY });
    const r = new ReplayRetention({ store, storePath: dir, retentionDays: 7, logger, now: () => NOW });
    const result = r.runOnce();
    expect(result.purged).toEqual(["abandoned"]);
  });

  it("allows a configurable grace period", () => {
    seed({ id: "abandoned-1h", startedAt: NOW - 90 * 60 * 1000 /* 1.5 hours */ });
    const r = new ReplayRetention({
      store,
      storePath: dir,
      retentionDays: 0.0001 /* effectively immediate */,
      incompleteGraceMs: HOUR /* 1h grace */,
      logger,
      now: () => NOW,
    });
    const result = r.runOnce();
    // grace expired 30 min ago; cutoff is now-0.0001*24h ≈ now-9s, so eligible
    expect(result.purged).toEqual(["abandoned-1h"]);
  });

  it("ignores orphan directories with missing meta.json instead of crashing", () => {
    mkdirSync(join(dir, "orphan"));
    seed({ id: "real", startedAt: NOW - 30 * DAY, endedAt: NOW - 30 * DAY + HOUR });
    const r = new ReplayRetention({ store, storePath: dir, retentionDays: 7, logger, now: () => NOW });
    const result = r.runOnce();
    expect(result.purged).toContain("real");
    expect(result.kept).toContain("orphan");
    expect(existsSync(join(dir, "orphan"))).toBe(true);
  });
});
