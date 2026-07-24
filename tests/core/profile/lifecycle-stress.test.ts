/**
 * Phase 4.5 C — direct stress tests on ProfileLifecycle + FilesystemProfileStore.
 *
 * These run against the real filesystem store + a mock CDP server. They verify:
 *   - Same-profile concurrency: must serialize via the lock. No deadlock.
 *   - Different-profile concurrency: must run in parallel without serializing.
 *   - Repeated churn: lifecycle.pendingCommits + store.locks must return to 0.
 *   - No orphan tmp files or lockfiles after stress.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { ProfileLifecycle, FilesystemProfileStore, initStore } from "../../../src/server/profile/index.js";
import type { CdpCookie } from "../../../src/core/profile/index.js";

const STRONG_PWD = Buffer.alloc(32, "s").toString("base64");

interface MockCdp {
  wsUrl: string;
  setCookies: (c: CdpCookie[]) => void;
  state: { getCalls: number; setCalls: number; openConns: number; totalConns: number };
  close: () => Promise<void>;
}

async function startMockCdp(): Promise<MockCdp> {
  const state = { getCalls: 0, setCalls: 0, openConns: 0, totalConns: 0 };
  let cookies: CdpCookie[] = [];
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    state.openConns++;
    state.totalConns++;
    ws.on("close", () => { state.openConns--; });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string; params?: { cookies?: CdpCookie[] } };
      if (msg.method === "Storage.getCookies") {
        state.getCalls++;
        ws.send(JSON.stringify({ id: msg.id, result: { cookies } }));
      } else if (msg.method === "Storage.setCookies") {
        state.setCalls++;
        cookies = msg.params?.cookies ?? [];
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
      } else {
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    wsUrl: `ws://127.0.0.1:${port}`,
    setCookies(c) { cookies = c; },
    state,
    async close() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let storeDir: string;
let store: FilesystemProfileStore;
let lifecycle: ProfileLifecycle;
let cdp: MockCdp;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "bg-lifecycle-stress-"));
  const opened = await initStore(storeDir, STRONG_PWD);
  store = new FilesystemProfileStore({ storePath: storeDir });
  cdp = await startMockCdp();
  lifecycle = new ProfileLifecycle(
    store,
    opened.dekByVersion,
    opened.currentDekVersion,
    pino({ level: "silent" }),
    { cdpTimeoutMs: 5_000, commitTimeoutMs: 2_000 },
  );
});

afterEach(async () => {
  await lifecycle.drain(2_000);
  await cdp.close();
  await rm(storeDir, { recursive: true, force: true });
});

describe("C1: same-profile concurrency serializes via the lock", () => {
  it("50 simultaneous acquire() calls for the same id — exactly one wins, rest get null lock", async () => {
    // 49 of these will collide on the lock and throw LOCK_HELD; 1 wins.
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => lifecycle.acquire("shared")),
    );

    const wins = results.filter((r) => r.status === "fulfilled");
    const losses = results.filter((r) => r.status === "rejected");

    expect(wins.length).toBe(1);
    expect(losses.length).toBe(49);
    // All losses must be the LOCK_HELD failure reason
    for (const l of losses as PromiseRejectedResult[]) {
      expect((l.reason as Error).name).toBe("LifecycleError");
      expect((l.reason as { reason?: string }).reason).toBe("LOCK_HELD");
    }

    // Release the one winner — lock should be free again
    await lifecycle.release((wins[0]! as PromiseFulfilledResult<{ lockToken: string; profileId: string; cookies: CdpCookie[]; isExisting: boolean }>).value);

    // A subsequent acquire should succeed
    const next = await lifecycle.acquire("shared");
    expect(next.lockToken).toBeTruthy();
    await lifecycle.release(next);
  });

  it("after stress on same profile, the in-memory lock Map is empty", async () => {
    // Hammer acquire / release cycles serially
    for (let i = 0; i < 50; i++) {
      const acq = await lifecycle.acquire("p");
      await lifecycle.release(acq);
    }

    // Internal state must be clean
    // @ts-expect-error — accessing private for test
    expect(store.locks.size).toBe(0);
  });
});

describe("C2: different-profile concurrency runs in parallel", () => {
  it("50 distinct profile ids acquire concurrently without serializing", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `p${i}`);

    const t0 = Date.now();
    const results = await Promise.all(ids.map((id) => lifecycle.acquire(id)));
    const elapsedMs = Date.now() - t0;

    expect(results.length).toBe(50);
    for (const r of results) expect(r.lockToken).toBeTruthy();

    // Parallel should be well under 50× a single acquire (fsync per profile may
    // add up, but even pessimistically it should be <2s on a healthy disk).
    expect(elapsedMs).toBeLessThan(3_000);

    await Promise.all(results.map((r) => lifecycle.release(r)));

    // @ts-expect-error — accessing private for test
    expect(store.locks.size).toBe(0);
  });
});

describe("C3: sustained acquire→inject→commit churn (memory + cleanup)", () => {
  it("100 full lifecycle cycles leave pendingCommits + locks at 0", async () => {
    const SEED: CdpCookie[] = [{ name: "k", value: "v", domain: ".test", path: "/", secure: true, httpOnly: false }];
    cdp.setCookies(SEED);

    for (let i = 0; i < 100; i++) {
      const id = `p${i}`;
      const acq = await lifecycle.acquire(id);
      // inject is a no-op when acquired.cookies is empty; first time around it is.
      // Inject something separately so we exercise the real CDP path too.
      const acqWith = { ...acq, cookies: SEED };
      await lifecycle.inject(acqWith, cdp.wsUrl);
      await lifecycle.commit(acqWith, cdp.wsUrl);
    }

    await lifecycle.drain(5_000);

    expect(lifecycle.pendingCommitCount()).toBe(0);
    // @ts-expect-error — accessing private field for test
    expect(store.locks.size).toBe(0);

    // 100 acquired + 100 committed = 100 sets + 100 gets to the mock
    expect(cdp.state.setCalls).toBe(100);
    expect(cdp.state.getCalls).toBe(100);

    // The mock should not be holding open WS connections from our transient clients
    // Allow a short window for sockets to fully close
    for (let i = 0; i < 20 && cdp.state.openConns > 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(cdp.state.openConns).toBe(0);

    // No leftover .lock dirs on disk
    const entries = await readdir(storeDir);
    const lockDirs = entries.filter((e) => e.endsWith(".lock"));
    expect(lockDirs).toEqual([]);
  }, 60_000);
});

describe("C4: rapid commit-then-acquire churn (M1 reconnect window)", () => {
  it("after 30 disconnect/reconnect cycles on same profile, no commits leak", async () => {
    cdp.setCookies([
      { name: "session", value: "alpha", domain: ".test", path: "/", secure: true, httpOnly: true },
    ]);

    for (let i = 0; i < 30; i++) {
      const acq = await lifecycle.acquire("p-rapid");
      // commit will go through (fire-and-forget) and on next loop the acquire
      // would block on the lock unless the previous commit released it.
      await lifecycle.commit(acq, cdp.wsUrl);
    }

    await lifecycle.drain(5_000);
    expect(lifecycle.pendingCommitCount()).toBe(0);
    // @ts-expect-error — accessing private field for test
    expect(store.locks.size).toBe(0);
  });
});

describe("C5: external commit preserves the browserserve IndexedDB layer", () => {
  it("using a full profile on an external provider does not wipe its IndexedDB files", async () => {
    const idb = [{ path: "IndexedDB/https_app_0.indexeddb.leveldb/000003.log", bytes: Buffer.from("leveldb").toString("base64") }];

    const seed = await lifecycle.acquire("idb-profile");
    await lifecycle.commitCaptured(seed, {
      cookies: [{ name: "sid", value: "seed", domain: ".app", path: "/", secure: true, httpOnly: true }],
      storage: {},
      indexeddb: idb,
    });

    const afterSeed = await lifecycle.acquireReadOnly("idb-profile");
    expect(afterSeed.indexeddb).toHaveLength(1);

    cdp.setCookies([{ name: "sid", value: "external", domain: ".app", path: "/", secure: true, httpOnly: true }]);
    const ext = await lifecycle.acquire("idb-profile");
    await lifecycle.commit(ext, cdp.wsUrl);
    await lifecycle.drain(5_000);

    const afterExternal = await lifecycle.acquireReadOnly("idb-profile");
    expect(afterExternal.indexeddb).toHaveLength(1);
    expect(afterExternal.indexeddb[0]!.path).toBe(idb[0]!.path);
    expect(afterExternal.indexeddb[0]!.bytes).toBe(idb[0]!.bytes);
    expect(afterExternal.cookies.some((c) => c.value === "external")).toBe(true);
  });
});
