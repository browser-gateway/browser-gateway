import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ReplayStore } from "../../src/server/replay/index.js";
import { createReplayRoutes } from "../../src/server/rest/replays.js";

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

function seed(opts: {
  id: string;
  startedAt: number;
  endedAt?: number;
  targets?: Array<{ id: string; frames: number[]; payloads: Buffer[] }>;
}): void {
  const sd = join(dir, opts.id);
  mkdirSync(sd, { recursive: true });
  writeFileSync(
    join(sd, "meta.json"),
    JSON.stringify({
      sessionId: opts.id,
      providerId: "p1",
      startedAt: opts.startedAt,
      endedAt: opts.endedAt,
      frameCount: opts.targets?.reduce((a, t) => a + t.frames.length, 0) ?? 0,
      sizeBytes: 0,
      complete: opts.endedAt !== undefined,
    }),
  );
  if (opts.endedAt !== undefined) {
    writeFileSync(join(sd, "complete.json"), JSON.stringify({ endedAt: opts.endedAt, frameCount: 0, sizeBytes: 0 }));
  }
  const targetsDir = join(sd, "targets");
  mkdirSync(targetsDir, { recursive: true });
  for (const t of opts.targets ?? []) {
    const td = join(targetsDir, t.id);
    mkdirSync(td, { recursive: true });
    const manifest = t.frames.map((f) => JSON.stringify({
      frame: f,
      ts: opts.startedAt + f * 100,
      url: `https://example.com/${f}`,
      deviceWidth: 1280,
      deviceHeight: 720,
      scrollX: 0,
      scrollY: 0,
      sizeBytes: t.payloads[f - 1]?.length ?? 0,
    })).join("\n");
    writeFileSync(join(td, "manifest.jsonl"), manifest);
    for (let i = 0; i < t.frames.length; i++) {
      const padded = String(t.frames[i]).padStart(6, "0");
      writeFileSync(join(td, `${padded}.png`), t.payloads[i]);
    }
  }
}

describe("REST routes with replay disabled", () => {
  it("GET /replays returns enabled: false + empty list", async () => {
    const app = createReplayRoutes({ store, logger, enabled: false });
    const res = await app.request("/replays");
    expect(res.status).toBe(200);
    const body = await res.json() as { enabled: boolean; replays: unknown[] };
    expect(body.enabled).toBe(false);
    expect(body.replays).toEqual([]);
  });

  it("GET /replays/:id returns 404 with disabled reason", async () => {
    const app = createReplayRoutes({ store, logger, enabled: false });
    const res = await app.request("/replays/some-id");
    expect(res.status).toBe(404);
  });
});

describe("REST routes with replay enabled", () => {
  it("GET /replays lists newest-first", async () => {
    seed({ id: "a", startedAt: 1000, endedAt: 1500 });
    seed({ id: "b", startedAt: 3000, endedAt: 3500 });
    seed({ id: "c", startedAt: 2000, endedAt: 2500 });
    const app = createReplayRoutes({ store, logger, enabled: true });
    const res = await app.request("/replays");
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; replays: Array<{ sessionId: string }> };
    expect(body.count).toBe(3);
    expect(body.replays.map((r) => r.sessionId)).toEqual(["b", "c", "a"]);
  });

  it("GET /replays accepts ?since= and ?limit=", async () => {
    seed({ id: "old", startedAt: 1000 });
    seed({ id: "fresh", startedAt: 50_000 });
    const app = createReplayRoutes({ store, logger, enabled: true });
    const res = await app.request(`/replays?since=${new Date(2000).toISOString()}&limit=1`);
    const body = await res.json() as { replays: Array<{ sessionId: string }> };
    expect(body.replays.map((r) => r.sessionId)).toEqual(["fresh"]);
  });

  it("GET /replays returns 400 on a malformed since", async () => {
    const app = createReplayRoutes({ store, logger, enabled: true });
    const res = await app.request("/replays?since=not-a-date");
    expect(res.status).toBe(400);
  });

  it("GET /replays/:id returns detail with targets", async () => {
    seed({
      id: "s1",
      startedAt: 1000,
      endedAt: 2000,
      targets: [
        { id: "T1", frames: [1, 2], payloads: [Buffer.from("x"), Buffer.from("y")] },
      ],
    });
    const app = createReplayRoutes({ store, logger, enabled: true });
    const res = await app.request("/replays/s1");
    expect(res.status).toBe(200);
    const body = await res.json() as { sessionId: string; targets: Array<{ targetId: string; frameCount: number }> };
    expect(body.sessionId).toBe("s1");
    expect(body.targets).toHaveLength(1);
    expect(body.targets[0].targetId).toBe("T1");
    expect(body.targets[0].frameCount).toBe(2);
  });

  it("GET /replays/:id returns 404 for unknown sessions", async () => {
    const app = createReplayRoutes({ store, logger, enabled: true });
    const res = await app.request("/replays/nope");
    expect(res.status).toBe(404);
  });

  it("GET /replays/:id rejects invalid session ids", async () => {
    const app = createReplayRoutes({ store, logger, enabled: true });
    const res = await app.request("/replays/bad%20id%21");
    expect(res.status).toBe(400);
  });

  it("DELETE /replays/:id purges the session", async () => {
    seed({ id: "s1", startedAt: 1000, endedAt: 2000 });
    const app = createReplayRoutes({ store, logger, enabled: true });
    const res = await app.request("/replays/s1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(store.get("s1")).toBeNull();
  });

  it("DELETE /replays/:id returns 404 when unknown", async () => {
    const app = createReplayRoutes({ store, logger, enabled: true });
    const res = await app.request("/replays/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("GET .../manifest streams the manifest.jsonl as application/jsonlines", async () => {
    seed({
      id: "s1",
      startedAt: 1000,
      endedAt: 2000,
      targets: [{ id: "T1", frames: [1, 2, 3], payloads: [Buffer.from(""), Buffer.from(""), Buffer.from("")] }],
    });
    const app = createReplayRoutes({ store, logger, enabled: true });
    const res = await app.request("/replays/s1/targets/T1/manifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/jsonlines");
    const lines = (await res.text()).split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
  });

  it("GET .../frames/000001.png serves the binary PNG with caching headers", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    seed({
      id: "s1",
      startedAt: 1000,
      endedAt: 2000,
      targets: [{ id: "T1", frames: [1], payloads: [png] }],
    });
    const app = createReplayRoutes({ store, logger, enabled: true });
    const res = await app.request("/replays/s1/targets/T1/frames/000001.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    const ab = await res.arrayBuffer();
    expect(new Uint8Array(ab)).toEqual(new Uint8Array(png));
  });

  it("GET .../frames returns 404 for missing frames", async () => {
    seed({ id: "s1", startedAt: 1000, endedAt: 2000, targets: [{ id: "T1", frames: [], payloads: [] }] });
    const app = createReplayRoutes({ store, logger, enabled: true });
    const res = await app.request("/replays/s1/targets/T1/frames/000099.png");
    expect(res.status).toBe(404);
  });

  it("GET .../frames rejects invalid frame names", async () => {
    seed({ id: "s1", startedAt: 1000, endedAt: 2000, targets: [{ id: "T1", frames: [], payloads: [] }] });
    const app = createReplayRoutes({ store, logger, enabled: true });
    const res = await app.request("/replays/s1/targets/T1/frames/not-a-frame.gif");
    expect(res.status).toBe(400);
  });
});
