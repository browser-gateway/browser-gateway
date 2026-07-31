import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ReplayStore } from "../../src/server/replay/index.js";
import { createReplayRoutes } from "../../src/server/rest/replays.js";
import type { ReplayFrameRecord, ReplayManifest } from "../../src/server/replay/types.js";

let dir: string;
let store: ReplayStore;
const logger = pino({ level: "silent" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bg-replay-rest-"));
  store = new ReplayStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function encodePart(frames: Buffer[]): { part: Buffer; offsets: number[] } {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let off = 0;
  for (const f of frames) {
    offsets.push(off);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(f.length, 0);
    chunks.push(len, f);
    off += 4 + f.length;
  }
  return { part: Buffer.concat(chunks), offsets };
}

function seed(opts: {
  id: string;
  startedAt: number;
  endedAt?: number;
  format?: "png" | "jpeg";
  targets?: Array<{ id: string; frames: Array<{ ts: number; url: string; payload: Buffer }> }>;
}): void {
  const sd = join(dir, opts.id);
  mkdirSync(sd, { recursive: true });
  const format = opts.format ?? "png";

  const frames: ReplayFrameRecord[] = [];
  const partsDir = join(sd, "parts");
  mkdirSync(partsDir, { recursive: true });
  let frameNumber = 0;
  let chunkIndex = 0;
  const targetIds = (opts.targets ?? []).map((t) => t.id);

  for (const target of opts.targets ?? []) {
    const payloads = target.frames.map((f) => f.payload);
    const { part, offsets } = encodePart(payloads);
    if (part.length > 0) {
      const partPath = join(partsDir, `${String(chunkIndex).padStart(3, "0")}.bin`);
      writeFileSync(partPath, part);
    }
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

  const manifest: ReplayManifest = {
    sessionId: opts.id,
    format,
    targets: targetIds,
    frames,
  };
  writeFileSync(join(sd, "manifest.json"), JSON.stringify(manifest));

  writeFileSync(
    join(sd, "meta.json"),
    JSON.stringify({
      sessionId: opts.id,
      providerId: "p1",
      startedAt: opts.startedAt,
      endedAt: opts.endedAt,
      frameCount: frames.length,
      sizeBytes: frames.reduce((a, f) => a + f.sizeBytes, 0),
      complete: opts.endedAt !== undefined,
      format,
    }),
  );
  if (opts.endedAt !== undefined) {
    writeFileSync(
      join(sd, "complete.json"),
      JSON.stringify({ endedAt: opts.endedAt, frameCount: frames.length, sizeBytes: 0 }),
    );
  }
}

describe("REST routes with replay enabled", () => {
  it("GET /replays lists newest-first", async () => {
    seed({ id: "a", startedAt: 1000, endedAt: 1500 });
    seed({ id: "b", startedAt: 3000, endedAt: 3500 });
    seed({ id: "c", startedAt: 2000, endedAt: 2500 });
    const app = createReplayRoutes({ store, logger });
    const res = await app.request("/replays");
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; replays: Array<{ sessionId: string }> };
    expect(body.count).toBe(3);
    expect(body.replays.map((r) => r.sessionId)).toEqual(["b", "c", "a"]);
  });

  it("GET /replays accepts ?since= and ?limit=", async () => {
    seed({ id: "old", startedAt: 1000 });
    seed({ id: "fresh", startedAt: 50_000 });
    const app = createReplayRoutes({ store, logger });
    const res = await app.request(`/replays?since=${new Date(2000).toISOString()}&limit=1`);
    const body = await res.json() as { replays: Array<{ sessionId: string }> };
    expect(body.replays.map((r) => r.sessionId)).toEqual(["fresh"]);
  });

  it("GET /replays returns 400 on a malformed since", async () => {
    const app = createReplayRoutes({ store, logger });
    const res = await app.request("/replays?since=not-a-date");
    expect(res.status).toBe(400);
  });

  it("GET /replays/:id returns detail with target summaries derived from manifest", async () => {
    seed({
      id: "s1",
      startedAt: 1000,
      endedAt: 2000,
      targets: [
        {
          id: "T1",
          frames: [
            { ts: 1100, url: "https://example.com/1", payload: Buffer.from("x") },
            { ts: 1200, url: "https://example.com/2", payload: Buffer.from("y") },
          ],
        },
      ],
    });
    const app = createReplayRoutes({ store, logger });
    const res = await app.request("/replays/s1");
    expect(res.status).toBe(200);
    const body = await res.json() as { sessionId: string; targets: Array<{ targetId: string; frameCount: number }> };
    expect(body.sessionId).toBe("s1");
    expect(body.targets).toHaveLength(1);
    expect(body.targets[0].targetId).toBe("T1");
    expect(body.targets[0].frameCount).toBe(2);
  });

  it("GET /replays/:id returns 404 for unknown sessions", async () => {
    const app = createReplayRoutes({ store, logger });
    const res = await app.request("/replays/nope");
    expect(res.status).toBe(404);
  });

  it("GET /replays/:id rejects invalid session ids", async () => {
    const app = createReplayRoutes({ store, logger });
    const res = await app.request("/replays/bad%20id%21");
    expect(res.status).toBe(400);
  });

  it("DELETE /replays/:id purges the session", async () => {
    seed({ id: "s1", startedAt: 1000, endedAt: 2000 });
    const app = createReplayRoutes({ store, logger });
    const res = await app.request("/replays/s1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(store.get("s1")).toBeNull();
  });

  it("DELETE /replays/:id returns 404 when unknown", async () => {
    const app = createReplayRoutes({ store, logger });
    const res = await app.request("/replays/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("GET /replays/:id/manifest returns the full manifest json", async () => {
    seed({
      id: "s1",
      startedAt: 1000,
      endedAt: 2000,
      targets: [
        {
          id: "T1",
          frames: [
            { ts: 1100, url: "https://example.com/1", payload: Buffer.from("aaa") },
            { ts: 1200, url: "https://example.com/2", payload: Buffer.from("bbb") },
            { ts: 1300, url: "https://example.com/3", payload: Buffer.from("ccc") },
          ],
        },
      ],
    });
    const app = createReplayRoutes({ store, logger });
    const res = await app.request("/replays/s1/manifest");
    expect(res.status).toBe(200);
    const body = await res.json() as ReplayManifest;
    expect(body.sessionId).toBe("s1");
    expect(body.frames).toHaveLength(3);
    expect(body.frames[0].chunkIndex).toBe(0);
  });

  it("GET /replays/:id/parts/000.bin serves the binary chunk", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    seed({
      id: "s1",
      startedAt: 1000,
      endedAt: 2000,
      targets: [{ id: "T1", frames: [{ ts: 1100, url: "https://example.com", payload: png }] }],
    });
    const app = createReplayRoutes({ store, logger });
    const res = await app.request("/replays/s1/parts/000.bin");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("cache-control")).toContain("immutable");
    const ab = await res.arrayBuffer();
    const bytes = new Uint8Array(ab);
    expect(bytes.byteLength).toBe(4 + png.length);
    expect(new DataView(ab).getUint32(0)).toBe(png.length);
  });

  it("GET /replays/:id/parts/999.bin returns 404 for missing part", async () => {
    seed({ id: "s1", startedAt: 1000, endedAt: 2000 });
    const app = createReplayRoutes({ store, logger });
    const res = await app.request("/replays/s1/parts/999.bin");
    expect(res.status).toBe(404);
  });

  it("GET /replays/:id/frames/:N.png extracts a single frame from the chunk", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    seed({
      id: "s1",
      startedAt: 1000,
      endedAt: 2000,
      targets: [{ id: "T1", frames: [{ ts: 1100, url: "https://example.com", payload: png }] }],
    });
    const app = createReplayRoutes({ store, logger });
    const res = await app.request("/replays/s1/frames/1.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    const ab = await res.arrayBuffer();
    expect(new Uint8Array(ab)).toEqual(new Uint8Array(png));
  });

  it("GET /replays/:id/frames returns 404 for missing frame number", async () => {
    seed({ id: "s1", startedAt: 1000, endedAt: 2000 });
    const app = createReplayRoutes({ store, logger });
    const res = await app.request("/replays/s1/frames/999.png");
    expect(res.status).toBe(404);
  });

  it("GET /replays/:id/frames rejects invalid frame names", async () => {
    seed({ id: "s1", startedAt: 1000, endedAt: 2000 });
    const app = createReplayRoutes({ store, logger });
    const res = await app.request("/replays/s1/frames/not-a-frame.gif");
    expect(res.status).toBe(400);
  });
});
