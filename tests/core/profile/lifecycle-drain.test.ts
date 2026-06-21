/**
 * Phase 4.5 hardening tests for ProfileLifecycle.
 *
 * H1: commit() is fire-and-forget at the upgrade-handler layer. If SIGTERM
 *     fires before commit completes, the latest cookies are lost. ProfileLifecycle
 *     needs a drain() that awaits in-flight commits.
 *
 * M2: capturing 0 cookies silently overwrites the previous saved state. Should
 *     log a warning and keep the previous state.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pino, { type Logger } from "pino";
import { ProfileLifecycle } from "../../../src/server/profile/lifecycle.js";
import {
  decodeBlob,
  encodeBlob,
  PROFILE_VERSION,
  type CapturedProfile,
  type CdpCookie,
} from "../../../src/core/profile/index.js";
import type { LockToken, ProfileStore } from "../../../src/core/profile/store.js";

class InMemoryStore implements ProfileStore {
  public blobs = new Map<string, Buffer>();
  public locked = new Set<string>();
  async getRaw(id: string) { return this.blobs.get(id) ?? null; }
  async putRaw(id: string, blob: Buffer) { this.blobs.set(id, blob); }
  async delete(id: string) { this.blobs.delete(id); }
  async list() { return []; }
  async lock(id: string): Promise<LockToken | null> {
    if (this.locked.has(id)) return null;
    this.locked.add(id);
    return `${id}-token`;
  }
  async unlock(id: string) { this.locked.delete(id); }
}

const DEK = Buffer.alloc(32, "k");
const DEKS = new Map([[1, DEK]]);

const COOKIES: CdpCookie[] = [
  { name: "session", value: "alice", domain: ".example.com", path: "/", secure: true, httpOnly: true },
];

// We need a real CDP server to make commit() actually do something.
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";

interface MockCdpServer {
  wsUrl: string;
  state: { cookies: CdpCookie[]; getCookiesDelayMs: number; getCookiesCalls: number; setCookiesCalls: number };
  close: () => Promise<void>;
}

async function startMockCdp(): Promise<MockCdpServer> {
  const state = { cookies: [] as CdpCookie[], getCookiesDelayMs: 0, getCookiesCalls: 0, setCookiesCalls: 0 };
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string; params?: { cookies?: CdpCookie[] } };
      if (msg.method === "Storage.getCookies") {
        state.getCookiesCalls++;
        if (state.getCookiesDelayMs > 0) {
          await new Promise((r) => setTimeout(r, state.getCookiesDelayMs));
        }
        ws.send(JSON.stringify({ id: msg.id, result: { cookies: state.cookies } }));
        return;
      }
      if (msg.method === "Storage.setCookies") {
        state.setCookiesCalls++;
        state.cookies = msg.params?.cookies ?? [];
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
        return;
      }
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    wsUrl: `ws://127.0.0.1:${port}`,
    state,
    async close() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface LogCapture { entries: Array<{ level: number; msg: string; obj: Record<string, unknown> }> }
function captureLogger(): { logger: Logger; cap: LogCapture } {
  const cap: LogCapture = { entries: [] };
  const dest = pino.transport({ target: "pino/file", options: { destination: 1 } });
  const logger = pino({
    level: "info",
    hooks: {
      logMethod(args, method, level) {
        const [obj, msg] = args;
        const objNorm = typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>) : {};
        const msgNorm = typeof msg === "string" ? msg : typeof obj === "string" ? obj : "";
        cap.entries.push({ level: Number(level), msg: msgNorm, obj: objNorm });
        method.apply(this, args);
      },
    },
  }, dest);
  return { logger, cap };
}

let store: InMemoryStore;
let cdp: MockCdpServer;
let lifecycle: ProfileLifecycle;
let cap: LogCapture;

beforeEach(async () => {
  store = new InMemoryStore();
  cdp = await startMockCdp();
  const made = captureLogger();
  cap = made.cap;
  lifecycle = new ProfileLifecycle(store, DEKS, 1, made.logger, { cdpTimeoutMs: 3_000 });
});

afterEach(async () => { await cdp.close(); });

describe("H1: drain() awaits in-flight commits before resolving", () => {
  it("drain() returns only after the slow commit has saved the profile", async () => {
    // First save a "previous" state via direct putRaw so we can detect overwrite later
    cdp.state.cookies = COOKIES;
    cdp.state.getCookiesDelayMs = 1_200;  // commit will take >1s

    const acquired = await lifecycle.acquire("p1");
    expect(acquired.lockToken).toBeTruthy();

    // Kick off commit but do NOT await — this is exactly what upgrade.ts does
    const fireAndForget = lifecycle.commit(acquired, cdp.wsUrl);

    // Immediately call drain (simulating SIGTERM → graceful shutdown)
    const t0 = Date.now();
    await lifecycle.drain(5_000);
    const drainMs = Date.now() - t0;

    // drain MUST have waited for commit to finish (≥ 1.2s)
    expect(drainMs).toBeGreaterThanOrEqual(1_000);

    // The profile MUST have been saved
    expect(store.blobs.has("p1")).toBe(true);
    const blob = store.blobs.get("p1")!;
    const decoded = decodeBlob(blob, DEK, "p1");
    const saved = JSON.parse(decoded.toString("utf8")) as CapturedProfile;
    expect(saved.cookies.length).toBe(1);
    expect(saved.cookies[0]!.name).toBe("session");

    // Make sure the still-pending promise resolves cleanly
    await fireAndForget;
  });

  it("drain(timeoutMs) returns after the deadline even if commits hang", async () => {
    cdp.state.cookies = COOKIES;
    cdp.state.getCookiesDelayMs = 10_000; // far longer than drain timeout

    const acquired = await lifecycle.acquire("p1");
    lifecycle.commit(acquired, cdp.wsUrl).catch(() => undefined); // hung

    const t0 = Date.now();
    await lifecycle.drain(500);
    const drainMs = Date.now() - t0;

    expect(drainMs).toBeGreaterThanOrEqual(500);
    expect(drainMs).toBeLessThan(1_500);
  });
});

describe("M2: capturing 0 cookies preserves previous state and logs WARN", () => {
  it("when previous state had cookies and capture returns empty, previous state is preserved", async () => {
    // Step 1: save a profile with one cookie (simulating prior session)
    const prevPlain = Buffer.from(JSON.stringify({
      version: PROFILE_VERSION,
      capturedAt: new Date().toISOString(),
      cookies: COOKIES,
      storage: {},
      meta: { capturedOrigins: [], skippedOrigins: [], durationMs: 0 },
    } satisfies CapturedProfile));
    const { bytes } = encodeBlob(DEK, 1, prevPlain, "p1");
    await store.putRaw("p1", bytes);

    // Step 2: capture returns empty cookies (user logged out / cleared cookies)
    cdp.state.cookies = [];

    const acquired = await lifecycle.acquire("p1");
    await lifecycle.commit(acquired, cdp.wsUrl);

    // After commit: stored profile should still have the previous cookies
    const after = store.blobs.get("p1")!;
    const decoded = decodeBlob(after, DEK, "p1");
    const saved = JSON.parse(decoded.toString("utf8")) as CapturedProfile;
    expect(saved.cookies.length).toBe(1);
    expect(saved.cookies[0]!.name).toBe("session");

    // And a WARN must have been logged about preserving previous state
    const warns = cap.entries.filter((e) => e.level === 40);
    const matched = warns.find((e) => /preserv|empty|0 cookies|previous/i.test(e.msg));
    expect(matched).toBeDefined();
  });

  it("when previous state was empty/none, saving empty cookies is normal (no WARN)", async () => {
    cdp.state.cookies = [];

    const acquired = await lifecycle.acquire("p1");
    await lifecycle.commit(acquired, cdp.wsUrl);

    expect(store.blobs.has("p1")).toBe(true);

    // No "preserved previous state" warning since there was nothing to preserve
    const matched = cap.entries.find(
      (e) => e.level === 40 && /preserv/i.test(e.msg),
    );
    expect(matched).toBeUndefined();
  });
});
