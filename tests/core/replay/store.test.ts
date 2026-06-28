/**
 * Filesystem-layout contract tests for ReplayStore. Builds the expected
 * directory shape under a `mkdtemp`, asserts list/get/delete behave as
 * specified in `planning/research/v0.3.5-SESSION-REPLAY-PLAN.md`.
 *
 * These tests double as the capture-side specification — when capture lands
 * on Day 2, it MUST produce a layout these tests pass against.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayStore } from "../../../src/server/replay/store.js";
import type { ReplayFrameRecord, ReplayMeta } from "../../../src/server/replay/types.js";

let dir: string;
let store: ReplayStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bg-replay-store-"));
  store = new ReplayStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedSession(opts: {
  id: string;
  providerId?: string;
  profileId?: string;
  startedAt: number;
  endedAt?: number;
  targets?: Array<{ id: string; frames: ReplayFrameRecord[]; framePayloads?: number[] }>;
}): void {
  const sessionDir = join(dir, opts.id);
  mkdirSync(sessionDir, { recursive: true });
  const meta: ReplayMeta = {
    sessionId: opts.id,
    providerId: opts.providerId ?? "browserless",
    profileId: opts.profileId,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    frameCount: opts.targets?.reduce((a, t) => a + t.frames.length, 0) ?? 0,
    sizeBytes: opts.targets?.reduce((a, t) => a + (t.framePayloads?.reduce((b, p) => b + p, 0) ?? 0), 0) ?? 0,
    complete: opts.endedAt !== undefined,
  };
  writeFileSync(join(sessionDir, "meta.json"), JSON.stringify(meta));
  if (opts.endedAt !== undefined) {
    writeFileSync(join(sessionDir, "complete.json"), JSON.stringify({
      endedAt: opts.endedAt,
      frameCount: meta.frameCount,
      sizeBytes: meta.sizeBytes,
    }));
  }
  const targetsDir = join(sessionDir, "targets");
  mkdirSync(targetsDir, { recursive: true });
  for (const t of opts.targets ?? []) {
    const td = join(targetsDir, t.id);
    mkdirSync(td, { recursive: true });
    const manifest = t.frames.map((f) => JSON.stringify(f)).join("\n");
    writeFileSync(join(td, "manifest.jsonl"), manifest);
    for (let i = 0; i < t.frames.length; i++) {
      const padded = String(t.frames[i].frame).padStart(6, "0");
      const payload = Buffer.alloc(t.framePayloads?.[i] ?? 0);
      writeFileSync(join(td, `${padded}.png`), payload);
    }
  }
}

const frame = (n: number, ts: number, url = "https://example.com"): ReplayFrameRecord => ({
  frame: n,
  ts,
  url,
  deviceWidth: 1280,
  deviceHeight: 720,
  scrollX: 0,
  scrollY: 0,
  sizeBytes: 0,
});

describe("ReplayStore.list", () => {
  it("returns [] when the store dir doesn't exist yet", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(store.list()).toEqual([]);
  });

  it("returns sessions newest-first by startedAt", () => {
    seedSession({ id: "a", startedAt: 1000, endedAt: 1500 });
    seedSession({ id: "b", startedAt: 3000, endedAt: 3500 });
    seedSession({ id: "c", startedAt: 2000, endedAt: 2500 });
    const ids = store.list().map((m) => m.sessionId);
    expect(ids).toEqual(["b", "c", "a"]);
  });

  it("respects `sinceMs`", () => {
    seedSession({ id: "old", startedAt: 100 });
    seedSession({ id: "new", startedAt: 5000 });
    expect(store.list({ sinceMs: 1000 }).map((m) => m.sessionId)).toEqual(["new"]);
  });

  it("respects `limit`", () => {
    for (let i = 0; i < 5; i++) seedSession({ id: `s${i}`, startedAt: i * 1000 });
    expect(store.list({ limit: 2 })).toHaveLength(2);
  });

  it("flags incomplete sessions with complete=false", () => {
    seedSession({ id: "running", startedAt: 1000 }); // no endedAt
    seedSession({ id: "done", startedAt: 2000, endedAt: 2500 });
    const got = store.list();
    expect(got.find((m) => m.sessionId === "running")?.complete).toBe(false);
    expect(got.find((m) => m.sessionId === "done")?.complete).toBe(true);
  });

  it("skips directories without meta.json", () => {
    mkdirSync(join(dir, "orphan"));
    seedSession({ id: "valid", startedAt: 1000, endedAt: 1500 });
    const ids = store.list().map((m) => m.sessionId);
    expect(ids).toEqual(["valid"]);
  });
});

describe("ReplayStore.get", () => {
  it("returns null for unknown sessions", () => {
    expect(store.get("nope")).toBeNull();
  });

  it("returns per-target summaries with frame counts + sizes", () => {
    seedSession({
      id: "s1",
      startedAt: 1000,
      endedAt: 2000,
      targets: [
        {
          id: "T1",
          frames: [
            frame(1, 1000, "https://a.com"),
            frame(2, 1200, "https://a.com/page"),
          ],
          framePayloads: [100, 200],
        },
        {
          id: "T2",
          frames: [frame(1, 1500)],
          framePayloads: [50],
        },
      ],
    });

    const detail = store.get("s1");
    expect(detail).not.toBeNull();
    expect(detail!.targets).toHaveLength(2);

    const t1 = detail!.targets.find((t) => t.targetId === "T1")!;
    expect(t1.frameCount).toBe(2);
    expect(t1.sizeBytes).toBe(300 + Buffer.byteLength(JSON.stringify(frame(1, 1000, "https://a.com")) + "\n" + JSON.stringify(frame(2, 1200, "https://a.com/page"))));
    expect(t1.firstUrl).toBe("https://a.com");
    expect(t1.lastUrl).toBe("https://a.com/page");
  });

  it("treats corrupt meta.json the same as missing", () => {
    const sessionDir = join(dir, "broken");
    mkdirSync(sessionDir);
    writeFileSync(join(sessionDir, "meta.json"), "{not json");
    expect(store.get("broken")).toBeNull();
  });
});

describe("ReplayStore.framePath + readManifest", () => {
  it("zero-pads frame numbers to 6 digits", () => {
    const p = store.framePath("s1", "T1", 42);
    expect(p.endsWith("000042.png")).toBe(true);
  });

  it("parses manifest.jsonl line-by-line", () => {
    seedSession({
      id: "s1",
      startedAt: 1000,
      endedAt: 1500,
      targets: [
        { id: "T1", frames: [frame(1, 1000), frame(2, 1200), frame(3, 1400)] },
      ],
    });
    const records = store.readManifest("s1", "T1");
    expect(records).toHaveLength(3);
    expect(records[0].frame).toBe(1);
    expect(records[2].ts).toBe(1400);
  });

  it("returns [] when the manifest doesn't exist yet", () => {
    expect(store.readManifest("nope", "T1")).toEqual([]);
  });
});

describe("ReplayStore.delete", () => {
  it("removes the session tree", () => {
    seedSession({ id: "s1", startedAt: 1000, endedAt: 1500 });
    expect(existsSync(join(dir, "s1"))).toBe(true);
    store.delete("s1");
    expect(existsSync(join(dir, "s1"))).toBe(false);
  });

  it("is idempotent on unknown sessions", () => {
    expect(() => store.delete("never-existed")).not.toThrow();
  });
});

describe("ReplayStore.sessionSizeBytes", () => {
  it("sums all files under the session", () => {
    seedSession({
      id: "s1",
      startedAt: 1000,
      endedAt: 2000,
      targets: [{ id: "T1", frames: [frame(1, 1000), frame(2, 1100)], framePayloads: [400, 600] }],
    });
    const total = store.sessionSizeBytes("s1");
    expect(total).toBeGreaterThanOrEqual(1000); // 400 + 600 PNG + meta + manifest
  });

  it("returns 0 for unknown sessions", () => {
    expect(store.sessionSizeBytes("nope")).toBe(0);
  });
});
