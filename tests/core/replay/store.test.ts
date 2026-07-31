import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayStore } from "../../../src/server/replay/store.js";
import type { ReplayFrameRecord, ReplayManifest, ReplayMeta } from "../../../src/server/replay/types.js";

let dir: string;
let store: ReplayStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bg-replay-store-"));
  store = new ReplayStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function encodePart(payloads: Buffer[]): { part: Buffer; offsets: number[] } {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let off = 0;
  for (const p of payloads) {
    offsets.push(off);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(p.length, 0);
    chunks.push(len, p);
    off += 4 + p.length;
  }
  return { part: Buffer.concat(chunks), offsets };
}

function seedSession(opts: {
  id: string;
  startedAt: number;
  endedAt?: number;
  providerId?: string;
  targets?: Array<{ id: string; frames: Array<{ ts: number; url: string; payload: Buffer }> }>;
}): void {
  const sessionDir = join(dir, opts.id);
  mkdirSync(sessionDir, { recursive: true });
  const partsDir = join(sessionDir, "parts");
  mkdirSync(partsDir, { recursive: true });

  const frames: ReplayFrameRecord[] = [];
  let frameNumber = 0;
  let chunkIndex = 0;
  const targetIds: string[] = [];

  for (const target of opts.targets ?? []) {
    targetIds.push(target.id);
    const payloads = target.frames.map((f) => f.payload);
    if (payloads.length > 0) {
      const { part, offsets } = encodePart(payloads);
      writeFileSync(join(partsDir, `${String(chunkIndex).padStart(3, "0")}.bin`), part);
      for (let i = 0; i < target.frames.length; i++) {
        frameNumber++;
        const f = target.frames[i];
        frames.push({
          frame: frameNumber,
          ts: f.ts,
          url: f.url,
          deviceWidth: 1280,
          deviceHeight: 720,
          scrollX: 0,
          scrollY: 0,
          sizeBytes: f.payload.length,
          targetId: target.id,
          chunkIndex,
          byteOffset: offsets[i],
          length: f.payload.length,
        });
      }
      chunkIndex++;
    }
  }

  const manifest: ReplayManifest = {
    sessionId: opts.id,
    format: "png",
    targets: targetIds,
    frames,
  };
  writeFileSync(join(sessionDir, "manifest.json"), JSON.stringify(manifest));

  const meta: ReplayMeta = {
    sessionId: opts.id,
    providerId: opts.providerId ?? "browserless",
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    frameCount: frames.length,
    sizeBytes: frames.reduce((a, f) => a + f.sizeBytes, 0),
    complete: opts.endedAt !== undefined,
    format: "png",
  };
  writeFileSync(join(sessionDir, "meta.json"), JSON.stringify(meta));
  if (opts.endedAt !== undefined) {
    writeFileSync(join(sessionDir, "complete.json"), JSON.stringify({
      endedAt: opts.endedAt,
      frameCount: meta.frameCount,
      sizeBytes: meta.sizeBytes,
    }));
  }
}

describe("ReplayStore.list", () => {
  it("returns [] when the store dir doesn't exist yet", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(store.list()).toEqual([]);
  });

  it("returns sessions newest-first by startedAt", () => {
    seedSession({ id: "a", startedAt: 1000, endedAt: 1500 });
    seedSession({ id: "b", startedAt: 3000, endedAt: 3500 });
    seedSession({ id: "c", startedAt: 2000, endedAt: 2500 });
    expect(store.list().map((m) => m.sessionId)).toEqual(["b", "c", "a"]);
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
    seedSession({ id: "running", startedAt: 1000 });
    seedSession({ id: "done", startedAt: 2000, endedAt: 2500 });
    const got = store.list();
    expect(got.find((m) => m.sessionId === "running")?.complete).toBe(false);
    expect(got.find((m) => m.sessionId === "done")?.complete).toBe(true);
  });

  it("skips directories without meta.json", () => {
    mkdirSync(join(dir, "orphan"));
    seedSession({ id: "valid", startedAt: 1000, endedAt: 1500 });
    expect(store.list().map((m) => m.sessionId)).toEqual(["valid"]);
  });
});

describe("ReplayStore.get", () => {
  it("returns null for unknown sessions", () => {
    expect(store.get("nope")).toBeNull();
  });

  it("returns per-target summaries derived from manifest frames", () => {
    seedSession({
      id: "s1",
      startedAt: 1000,
      endedAt: 2000,
      targets: [
        {
          id: "T1",
          frames: [
            { ts: 1000, url: "https://a.com", payload: Buffer.alloc(100) },
            { ts: 1200, url: "https://a.com/page", payload: Buffer.alloc(200) },
          ],
        },
        {
          id: "T2",
          frames: [{ ts: 1500, url: "https://b.com", payload: Buffer.alloc(50) }],
        },
      ],
    });
    const detail = store.get("s1");
    expect(detail).not.toBeNull();
    expect(detail!.targets).toHaveLength(2);
    const t1 = detail!.targets.find((t) => t.targetId === "T1")!;
    expect(t1.frameCount).toBe(2);
    expect(t1.sizeBytes).toBe(300);
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

describe("ReplayStore.readManifest + readFrame", () => {
  it("returns null when the manifest doesn't exist yet", () => {
    expect(store.readManifest("nope")).toBeNull();
  });

  it("readFrame extracts a single frame from a chunk part", () => {
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    seedSession({
      id: "s1",
      startedAt: 1000,
      endedAt: 2000,
      targets: [{ id: "T1", frames: [{ ts: 1000, url: "https://example.com", payload }] }],
    });
    const frame = store.readFrame("s1", 1);
    expect(frame).not.toBeNull();
    expect(Buffer.from(frame!)).toEqual(payload);
  });

  it("readFrame returns null for a missing frame number", () => {
    seedSession({ id: "s1", startedAt: 1000, endedAt: 2000 });
    expect(store.readFrame("s1", 99)).toBeNull();
  });

  it("partPath produces zero-padded 3-digit names", () => {
    expect(store.partPath("s1", 0).endsWith("000.bin")).toBe(true);
    expect(store.partPath("s1", 42).endsWith("042.bin")).toBe(true);
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
      targets: [{ id: "T1", frames: [{ ts: 1000, url: "https://example.com", payload: Buffer.alloc(400) }] }],
    });
    expect(store.sessionSizeBytes("s1")).toBeGreaterThan(400);
  });

  it("returns 0 for unknown sessions", () => {
    expect(store.sessionSizeBytes("nope")).toBe(0);
  });
});
