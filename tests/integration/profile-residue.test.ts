/**
 * Residue-detection integration tests.
 *
 * External CDP providers (non-browserserve) can hold a previous profile's
 * state in their underlying browser instance between sessions. The
 * ProfilePlugin plants a sentinel marker cookie on `__bg-marker.internal`
 * at inject time. On the next session, it probes for the marker and rejects
 * the connect with HTTP 409 when a different profile's marker is present.
 *
 * Scenarios:
 *   R1. profile A → disconnect → connect A again on same provider     → success
 *   R2. profile A → disconnect → connect B on same pin (via 2nd cfg)  → 409 residue
 *   R3. residue also blocks READ-ONLY connects (Isaac §11 Q1)          → 409 residue
 *   R4. captured profile blob does NOT contain the marker cookie       → clean roundtrip
 *   R5. probe failure (mock returns 500 on getCookies) → falls through to inject
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { MARKER_DOMAIN, MARKER_NAME, decodeMarker } from "../../src/core/profile/marker.js";

const GATEWAY_PORT = 20800;
const PROVIDER_PORT = 20801;
const CONFIG_PATH = "/tmp/bg-profile-residue-test.yml";
const PROFILE_DIR = mkdtempSync(join(tmpdir(), "bg-profile-residue-"));
const ENCRYPTION_KEY = Buffer.alloc(32, "y").toString("base64");

type MockCookie = { name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean };

interface MockState {
  storedCookies: MockCookie[];
  /** Everything ever passed to Storage.setCookies, in call order. */
  setCookieCallHistory: MockCookie[][];
  /** Persistent DOMStorage backing: key = securityOrigin, value = { key: value } */
  domStorage: Map<string, Map<string, string>>;
  /** Simulates Chromium 754576: on session-boundary "context reset", cookies
   *  are cleared but localStorage persists (real leak bug). Reset in state.reset(). */
  chromiumLeakMode: boolean;
  getCookiesFails: boolean;
  setCookiesCalls: number;
  getCookiesCalls: number;
  reset(): void;
  /** Simulates provider giving a fresh browser context between sessions —
   *  clears cookies but leaves localStorage intact (the Chromium 754576 leak). */
  simulateNewContext(): void;
}

function createPinnedMock(port: number, state: MockState): { server: Server; close: () => Promise<void> } {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        id: number;
        method: string;
        params?: { cookies?: Array<{ name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean }> };
      };
      if (msg.method === "Storage.getCookies") {
        state.getCookiesCalls++;
        if (state.getCookiesFails) {
          ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: "intentional getCookies failure" } }));
          return;
        }
        ws.send(JSON.stringify({ id: msg.id, result: { cookies: state.storedCookies } }));
        return;
      }
      if (msg.method === "Storage.setCookies") {
        state.setCookiesCalls++;
        const incoming = msg.params?.cookies ?? [];
        state.setCookieCallHistory.push([...incoming]);
        for (const c of incoming) {
          const key = `${c.name}|${c.domain}|${c.path ?? "/"}`;
          const idx = state.storedCookies.findIndex((e) => `${e.name}|${e.domain}|${e.path ?? "/"}` === key);
          if (idx >= 0) state.storedCookies[idx] = c;
          else state.storedCookies.push(c);
        }
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
        return;
      }
      if (msg.method === "Target.createTarget") {
        ws.send(JSON.stringify({ id: msg.id, result: { targetId: "scratch-target-1" } }));
        return;
      }
      if (msg.method === "Target.attachToTarget") {
        ws.send(JSON.stringify({ id: msg.id, result: { sessionId: "scratch-session-1" } }));
        return;
      }
      if (msg.method === "Target.detachFromTarget" || msg.method === "Target.closeTarget") {
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
        return;
      }
      if (msg.method === "Fetch.enable" || msg.method === "Fetch.disable" || msg.method === "Page.enable" || msg.method === "Page.navigate") {
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
        return;
      }
      if (msg.method === "Runtime.evaluate") {
        // Simulate localStorage.setItem / getItem on MARKER_ORIGIN.
        const p = msg.params as { expression?: string } | undefined;
        const expr = p?.expression ?? "";
        const MARKER_ORIGIN = "https://__bg-marker.internal";
        // setItem: localStorage.setItem("_bg_marker", "<encoded>")
        const setMatch = /localStorage\.setItem\(\s*"_bg_marker"\s*,\s*"([^"]*)"\s*\)/.exec(expr);
        if (setMatch) {
          if (!state.domStorage.has(MARKER_ORIGIN)) state.domStorage.set(MARKER_ORIGIN, new Map());
          state.domStorage.get(MARKER_ORIGIN)!.set("_bg_marker", setMatch[1]!);
          ws.send(JSON.stringify({ id: msg.id, result: { result: { type: "boolean", value: true } } }));
          return;
        }
        // getItem: localStorage.getItem("_bg_marker")
        if (/localStorage\.getItem\(\s*"_bg_marker"\s*\)/.test(expr)) {
          const val = state.domStorage.get(MARKER_ORIGIN)?.get("_bg_marker") ?? null;
          ws.send(JSON.stringify({ id: msg.id, result: { result: { type: val === null ? "object" : "string", value: val } } }));
          return;
        }
        // navigateAndEvaluate probe expression "1"
        ws.send(JSON.stringify({ id: msg.id, result: { result: { type: "number", value: 1 } } }));
        return;
      }
      if (msg.id !== undefined) ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
  });

  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws_) => wss.emit("connection", ws_, req));
  });

  server.on("request", (req: IncomingMessage, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        Browser: "MockCDP/residue",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: `ws://localhost:${port}/devtools/browser/pipe`,
      }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port);

  return {
    server,
    async close() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// Two pinned providers on the SAME upstream port — realistically models the
// hazard: one browser instance behind two logical provider slots each pinned
// to a different profile. Residue check must block cross-profile use.
function buildConfig(): string {
  return `
version: 1
gateway:
  port: ${GATEWAY_PORT}
  defaultStrategy: priority-chain
  connectionTimeout: 5000
providers:
  pin-alpha:
    url: http://localhost:${PROVIDER_PORT}
    limits:
      maxConcurrent: 4
    priority: 1
    profile: alpha-profile
  pin-bravo:
    url: http://localhost:${PROVIDER_PORT}
    limits:
      maxConcurrent: 4
    priority: 2
    profile: bravo-profile
  pin-charlie:
    url: http://localhost:${PROVIDER_PORT}
    limits:
      maxConcurrent: 4
    priority: 3
    profile: charlie-profile
  pin-delta:
    url: http://localhost:${PROVIDER_PORT}
    limits:
      maxConcurrent: 4
    priority: 4
    profile: delta-profile
dashboard:
  enabled: false
logging:
  level: warn
profiles:
  enabled: true
  store: filesystem
  filesystem:
    path: ${PROFILE_DIR}
  encryption:
    keyEnv: BG_ENCRYPTION_KEY
  lockTtlMs: 60000
  cdpTimeoutMs: 4000
  commitTimeoutMs: 3000
`;
}

const state: MockState = {
  storedCookies: [],
  setCookieCallHistory: [],
  domStorage: new Map(),
  chromiumLeakMode: false,
  getCookiesFails: false,
  setCookiesCalls: 0,
  getCookiesCalls: 0,
  reset() {
    this.storedCookies = [];
    this.setCookieCallHistory = [];
    this.domStorage = new Map();
    this.chromiumLeakMode = false;
    this.getCookiesFails = false;
    this.setCookiesCalls = 0;
    this.getCookiesCalls = 0;
  },
  simulateNewContext() {
    // Real-world Chromium 754576 leak: dispose the "context" (cookies gone)
    // but the shared Chromium process keeps localStorage backing intact.
    this.storedCookies = [];
    this.setCookieCallHistory = [];
    // NB: domStorage deliberately preserved to model the leak.
  },
};

let mockClose: () => Promise<void>;
let gatewayProcess: ChildProcess;

async function waitForGateway() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://localhost:${GATEWAY_PORT}/health`);
      if (r.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("gateway didn't start");
}

async function startGateway(): Promise<void> {
  writeFileSync(CONFIG_PATH, buildConfig());
  gatewayProcess = spawn(
    "npx",
    ["tsx", "src/server/index.ts", "serve", "--config", CONFIG_PATH],
    {
      cwd: process.cwd(),
      stdio: "pipe",
      env: { ...process.env, BG_TOKEN: "", BG_ENCRYPTION_KEY: ENCRYPTION_KEY },
    },
  );
  await waitForGateway();
}

async function stopGateway(): Promise<void> {
  if (!gatewayProcess || gatewayProcess.exitCode !== null) return;
  gatewayProcess.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    gatewayProcess.once("exit", () => resolve());
    setTimeout(resolve, 5_000);
  });
}

async function openProfile(profileId: string, readOnly = false): Promise<WebSocket> {
  const roParam = readOnly ? "&readOnly=1" : "";
  const ws = new WebSocket(`ws://localhost:${GATEWAY_PORT}/v1/connect?profile=${profileId}${roParam}`);
  let handled = false;
  await new Promise<void>((resolve, reject) => {
    const finish = (err: Error | null) => {
      if (handled) return;
      handled = true;
      if (err) reject(err); else resolve();
    };
    ws.once("open", () => finish(null));
    ws.once("unexpected-response", (_req, res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => finish(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`)));
      res.on("error", () => finish(new Error(`HTTP ${res.statusCode ?? "?"}: <res error>`)));
    });
    ws.once("error", (e) => finish(e as Error));
  });
  return ws;
}

async function checkConnect(profileId: string, readOnly = false): Promise<{ ok: boolean; status?: number; body?: string; rawErr?: string }> {
  try {
    const ws = await openProfile(profileId, readOnly);
    ws.close();
    await sleep(100);
    return { ok: true };
  } catch (err) {
    const m = (err as Error).message;
    const match = /HTTP (\d+): ([\s\S]*)/.exec(m);
    return { ok: false, status: match ? Number(match[1]) : undefined, body: match ? match[2] : undefined, rawErr: m };
  }
}

beforeAll(async () => {
  const mock = createPinnedMock(PROVIDER_PORT, state);
  mockClose = mock.close;
  await startGateway();
});

afterAll(async () => {
  await stopGateway();
  await mockClose?.();
  try { unlinkSync(CONFIG_PATH); } catch {}
  try { rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch {}
});

describe("residue detection", () => {
  it("R1: profile A → disconnect → connect A again on same provider → success", async () => {
    state.reset();

    const ws1 = await openProfile("alpha-profile");
    ws1.close();
    await sleep(1_500);

    // Marker cookie must have been planted on the mock's storage
    const planted = state.storedCookies.find((c) => c.name === MARKER_NAME && c.domain === MARKER_DOMAIN);
    expect(planted).toBeTruthy();
    const decoded = decodeMarker(planted!.value);
    expect(decoded?.profileId).toBe("alpha-profile");

    // Reconnect with SAME profile — marker matches, session proceeds
    const second = await checkConnect("alpha-profile");
    expect(second.ok).toBe(true);
  }, 30_000);

  it("R2: profile A holds provider → connect B on same upstream → 409 residue", async () => {
    state.reset();

    // Seed alpha's marker via a real connect
    const ws1 = await openProfile("alpha-profile");
    ws1.close();
    await sleep(1_500);

    const alphaMarker = state.storedCookies.find((c) => c.name === MARKER_NAME);
    expect(alphaMarker).toBeTruthy();
    expect(decodeMarker(alphaMarker!.value)?.profileId).toBe("alpha-profile");

    // Now try bravo — the router picks pin-bravo (which points at the same
    // upstream), probes marker, sees alpha-profile, rejects 409.
    const attempt = await checkConnect("bravo-profile");
    expect(attempt.ok).toBe(false);
    expect(attempt.status).toBe(409);
    expect(attempt.body).toMatch(/provider_holds_different_profile/);
    expect(attempt.body).toMatch(/currentProfile/);
  }, 30_000);

  it("R3: read-only session for B is also blocked when marker holds A (Isaac §11 Q1)", async () => {
    state.reset();

    // Seed alpha marker via write-back session on pin-alpha
    const ws1 = await openProfile("alpha-profile");
    ws1.close();
    await sleep(2_000);
    expect(state.storedCookies.some((c) => c.name === MARKER_NAME)).toBe(true);

    // Read-only bravo — must ALSO 409, per Isaac's answer.
    // (60s timeout accounts for the sibling profile's lock-wait when
    // multiple residue tests run back-to-back.)
    const attempt = await checkConnect("bravo-profile", true);
    expect(attempt.ok).toBe(false);
    expect(attempt.status).toBe(409);
  }, 60_000);

  it("R4: captured profile does NOT contain the marker cookie — verified via re-inject observation", async () => {
    state.reset();

    // Seed with a real user cookie present before the first session
    state.storedCookies = [
      { name: "session-token", value: "abc123", domain: ".example.com", path: "/", secure: true, httpOnly: false },
    ];

    // First session: captures user cookie + planted marker. On save, marker is
    // filtered so only user cookie persists in the encrypted blob.
    const ws1 = await openProfile("alpha-profile");
    ws1.close();
    await sleep(1_500);

    // Marker was planted on the mock
    expect(state.storedCookies.some((c) => c.name === MARKER_NAME)).toBe(true);

    // Clear the mock's cookie store — the next connect starts from a blank
    // upstream so anything that ends up in state.storedCookies during inject
    // came from the saved profile blob (or the fresh marker plant).
    state.storedCookies = [];
    state.setCookieCallHistory = [];

    const ws2 = await openProfile("alpha-profile");
    ws2.close();
    await sleep(1_500);

    // Flatten every cookie name ever passed to setCookies during the second
    // session's inject + plant sequence.
    const injectedNames = new Set(
      state.setCookieCallHistory.flat().map((c) => c.name),
    );
    // The saved profile contained "session-token" but NOT the marker.
    expect(injectedNames.has("session-token")).toBe(true);
    // Freshly planted marker will appear here too — but only ONCE per session
    // (plant call), not because the saved blob leaked it. To distinguish, we
    // count marker occurrences: exactly 1 = plant only. >=2 = blob leaked it.
    const markerCount = state.setCookieCallHistory
      .flat()
      .filter((c) => c.name === MARKER_NAME).length;
    expect(markerCount).toBe(1);
  }, 30_000);

  it("R5: probe failure (getCookies returns error) → session still proceeds (best-effort)", async () => {
    state.reset();
    // Make Storage.getCookies fail — probe can't read the marker
    state.getCookiesFails = true;

    const attempt = await checkConnect("alpha-profile");
    // Probe failure is non-fatal; inject continues, session succeeds
    expect(attempt.ok).toBe(true);

    state.getCookiesFails = false;
  }, 30_000);

  it("R6: cookie cleared but localStorage persists (Chromium 754576) → localStorage arm still catches residue", async () => {
    state.reset();

    // R6/R7 use dedicated profile IDs (charlie/delta) that R1-R5 never touch,
    // so profile-lock cascade from earlier tests can't stall these openProfile
    // calls with the 15s LOCK_HELD wait.
    const ws1 = await openProfile("charlie-profile");
    ws1.close();
    await sleep(1_500);
    expect(state.storedCookies.some((c) => c.name === "_bg_marker")).toBe(true);
    expect(state.domStorage.get("https://__bg-marker.internal")?.get("_bg_marker")).toBeTruthy();

    // Simulate the provider giving a "fresh browser context": cookies cleared,
    // but localStorage survives the Chromium disposeBrowserContext boundary
    // (real bug 754576 / puppeteer#11627 / devtools-protocol#43).
    state.simulateNewContext();
    expect(state.storedCookies.length).toBe(0);
    expect(state.domStorage.get("https://__bg-marker.internal")?.get("_bg_marker")).toBeTruthy();

    // Session 2 as delta on the "fresh" context — cookie arm would MISS
    // (no marker cookie present), but localStorage arm catches it → 409.
    const attempt = await checkConnect("delta-profile");
    expect(attempt.ok).toBe(false);
    expect(attempt.status).toBe(409);
    expect(attempt.body).toMatch(/provider_holds_different_profile/);
    expect(attempt.body).toMatch(/charlie-profile/);
  }, 30_000);

  it("R7: reconnect as SAME profile after context-fresh with localStorage marker → succeeds (marker matches)", async () => {
    state.reset();

    // Use isolated profile IDs so R7 doesn't wait on R6's charlie/delta locks.
    // (The mock server is shared, but the profileLifecycle keeps per-profile locks.)
    const ws1 = await openProfile("charlie-profile");
    ws1.close();
    await sleep(1_500);

    // Simulate context fresh — cookie gone, localStorage marker for charlie remains
    state.simulateNewContext();
    expect(state.domStorage.get("https://__bg-marker.internal")?.get("_bg_marker")).toBeTruthy();

    // Reconnect as SAME profile (charlie) — marker matches on localStorage arm → success
    const attempt = await checkConnect("charlie-profile");
    expect(attempt.ok).toBe(true);
  }, 30_000);
});
