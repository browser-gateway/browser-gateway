/**
 * Unit tests for `prepareCookieForInject` and the transient-CDP cookie helpers.
 *
 * Each test targets a specific conditional in the source so a mutation testing
 * pass can't silently break field-filtering logic. See `stryker.config.json`.
 */
import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import {
  captureCookiesViaTransient,
  injectCookiesViaTransient,
  prepareCookieForInject,
} from "../../../src/core/profile/cookie-helpers.js";
import type { CdpCookie } from "../../../src/core/profile/cdp.js";

function baseCookie(extra: Partial<CdpCookie> = {}): CdpCookie {
  return {
    name: "session",
    value: "abc",
    domain: ".example.com",
    path: "/",
    secure: true,
    httpOnly: true,
    ...extra,
  };
}

describe("prepareCookieForInject", () => {
  it("copies the required fields verbatim", () => {
    const out = prepareCookieForInject(baseCookie());
    expect(out).toMatchObject({
      name: "session",
      value: "abc",
      domain: ".example.com",
      path: "/",
      secure: true,
      httpOnly: true,
    });
  });

  // ── expires ──
  it("includes expires when > 0", () => {
    const out = prepareCookieForInject(baseCookie({ expires: 12345 }));
    expect(out.expires).toBe(12345);
  });

  it("omits expires when exactly 0 (sentinel for session cookies)", () => {
    const out = prepareCookieForInject(baseCookie({ expires: 0 }));
    expect(out).not.toHaveProperty("expires");
  });

  it("omits expires when undefined", () => {
    const out = prepareCookieForInject(baseCookie());
    expect(out).not.toHaveProperty("expires");
  });

  // Boundary test: distinguishes `> 0` from `>= 0`
  it("omits expires when negative (treated as not set)", () => {
    const out = prepareCookieForInject(baseCookie({ expires: -1 }));
    expect(out).not.toHaveProperty("expires");
  });

  // ── sameSite ──
  it("includes sameSite when set to Strict", () => {
    const out = prepareCookieForInject(baseCookie({ sameSite: "Strict" }));
    expect(out.sameSite).toBe("Strict");
  });

  it("includes sameSite when set to Lax", () => {
    const out = prepareCookieForInject(baseCookie({ sameSite: "Lax" }));
    expect(out.sameSite).toBe("Lax");
  });

  it("omits sameSite when undefined", () => {
    const out = prepareCookieForInject(baseCookie());
    expect(out).not.toHaveProperty("sameSite");
  });

  // ── priority ──
  it("includes priority when set to High", () => {
    const out = prepareCookieForInject(baseCookie({ priority: "High" }));
    expect(out.priority).toBe("High");
  });

  it("omits priority when undefined", () => {
    const out = prepareCookieForInject(baseCookie());
    expect(out).not.toHaveProperty("priority");
  });

  // ── sourceScheme ──
  it("includes sourceScheme when 'Secure'", () => {
    const out = prepareCookieForInject(baseCookie({ sourceScheme: "Secure" }));
    expect(out.sourceScheme).toBe("Secure");
  });

  it("includes sourceScheme when 'NonSecure'", () => {
    const out = prepareCookieForInject(baseCookie({ sourceScheme: "NonSecure" }));
    expect(out.sourceScheme).toBe("NonSecure");
  });

  it("omits sourceScheme when 'Unset' (Chrome sentinel)", () => {
    const out = prepareCookieForInject(baseCookie({ sourceScheme: "Unset" }));
    expect(out).not.toHaveProperty("sourceScheme");
  });

  it("omits sourceScheme when undefined", () => {
    const out = prepareCookieForInject(baseCookie());
    expect(out).not.toHaveProperty("sourceScheme");
  });

  // ── sourcePort ──
  it("includes sourcePort when > 0", () => {
    const out = prepareCookieForInject(baseCookie({ sourcePort: 443 }));
    expect(out.sourcePort).toBe(443);
  });

  it("omits sourcePort when exactly 0", () => {
    const out = prepareCookieForInject(baseCookie({ sourcePort: 0 }));
    expect(out).not.toHaveProperty("sourcePort");
  });

  it("omits sourcePort when negative", () => {
    const out = prepareCookieForInject(baseCookie({ sourcePort: -1 }));
    expect(out).not.toHaveProperty("sourcePort");
  });

  it("omits sourcePort when undefined", () => {
    const out = prepareCookieForInject(baseCookie());
    expect(out).not.toHaveProperty("sourcePort");
  });

  // ── sameParty ──
  it("includes sameParty when true", () => {
    const out = prepareCookieForInject(baseCookie({ sameParty: true }));
    expect(out.sameParty).toBe(true);
  });

  it("includes sameParty when false (explicitly set)", () => {
    const out = prepareCookieForInject(baseCookie({ sameParty: false }));
    expect(out.sameParty).toBe(false);
  });

  it("omits sameParty when undefined", () => {
    const out = prepareCookieForInject(baseCookie());
    expect(out).not.toHaveProperty("sameParty");
  });

  // ── partitionKey ──
  it("includes partitionKey when set", () => {
    const out = prepareCookieForInject(
      baseCookie({ partitionKey: "https://example.com" } as Partial<CdpCookie>),
    );
    expect(out.partitionKey).toBe("https://example.com");
  });

  it("includes partitionKey when explicitly empty string", () => {
    const out = prepareCookieForInject(baseCookie({ partitionKey: "" } as Partial<CdpCookie>));
    expect(out.partitionKey).toBe("");
  });

  it("omits partitionKey when undefined", () => {
    const out = prepareCookieForInject(baseCookie());
    expect(out).not.toHaveProperty("partitionKey");
  });

  // ── Strips out the read-only metadata Chrome includes in getAllCookies ──
  it("does NOT carry over read-only metadata fields like 'size' and 'session'", () => {
    const fromGet = baseCookie({
      // These fields exist on the CdpCookie type from getAllCookies but are
      // rejected by setCookies. They MUST be stripped.
      // (Casting because they may not be in the strict type union.)
      ...({ size: 99, session: true } as Partial<CdpCookie>),
    });
    const out = prepareCookieForInject(fromGet);
    expect(out).not.toHaveProperty("size");
    expect(out).not.toHaveProperty("session");
  });
});

// ─── Transient CDP helpers (capture / inject) ───
//
// These exercise the WebSocket round-trip with a tiny mock server so the
// withDeadline + connect + send + close flow is mutation-tested too.

interface MockCdp {
  wsUrl: string;
  setLastCookies(c: CdpCookie[]): void;
  setReturnsNullCookies(): void;
  setHangsOnSend(): void;
  close: () => Promise<void>;
}

async function startMockCdp(): Promise<MockCdp> {
  let storedCookies: CdpCookie[] = [];
  let returnsNullCookies = false;
  let hangsOnSend = false;
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        id: number;
        method: string;
        params?: { cookies?: CdpCookie[] };
      };
      if (hangsOnSend) return;
      if (msg.method === "Storage.getCookies") {
        if (returnsNullCookies) {
          ws.send(JSON.stringify({ id: msg.id, result: null }));
          return;
        }
        ws.send(JSON.stringify({ id: msg.id, result: { cookies: storedCookies } }));
        return;
      }
      if (msg.method === "Storage.setCookies") {
        storedCookies = msg.params?.cookies ?? [];
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
    setLastCookies(c) { storedCookies = c; },
    setReturnsNullCookies() { returnsNullCookies = true; },
    setHangsOnSend() { hangsOnSend = true; },
    async close() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("captureCookiesViaTransient", () => {
  it("round-trips: sets cookies, then captures the same set back", async () => {
    const cdp = await startMockCdp();
    try {
      const seed: CdpCookie[] = [
        { name: "a", value: "1", domain: ".x", path: "/", secure: true, httpOnly: false },
      ];
      cdp.setLastCookies(seed);
      const captured = await captureCookiesViaTransient(cdp.wsUrl, 3_000);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.name).toBe("a");
    } finally {
      await cdp.close();
    }
  });

  // Distinguishes `res?.cookies ?? []` from `res.cookies ?? []`. With null
  // result, the optional chaining returns undefined → fallback to `[]`. Without
  // optional chaining, accessing `.cookies` on null would throw.
  it("returns [] when Storage.getCookies replies with null result", async () => {
    const cdp = await startMockCdp();
    try {
      cdp.setReturnsNullCookies();
      const out = await captureCookiesViaTransient(cdp.wsUrl, 3_000);
      expect(out).toEqual([]);
    } finally {
      await cdp.close();
    }
  });

  // The withDeadline path: if the peer never responds, we reject the operation
  // after timeoutMs with a "captureCookiesViaTransient timeout" message.
  it("rejects with a timeout error when the peer hangs", async () => {
    const cdp = await startMockCdp();
    try {
      cdp.setHangsOnSend();
      await expect(
        captureCookiesViaTransient(cdp.wsUrl, 200),
      ).rejects.toThrow(/captureCookiesViaTransient timeout after 200ms/);
    } finally {
      await cdp.close();
    }
  });
});

describe("injectCookiesViaTransient", () => {
  // Distinguishes the early-return guard `if (cookies.length === 0) return;`
  // from a `false` mutation that would still attempt the network round-trip.
  it("is a no-op when the cookie array is empty (does not connect)", async () => {
    // Pass a bogus URL — if connect IS attempted, the test will fail with a
    // connection error. The early-return guard must short-circuit.
    await expect(
      injectCookiesViaTransient("ws://127.0.0.1:1", [], 200),
    ).resolves.toBeUndefined();
  });

  it("sends the prepared cookies via Storage.setCookies", async () => {
    const cdp = await startMockCdp();
    try {
      const cookies: CdpCookie[] = [
        { name: "k", value: "v", domain: ".x", path: "/", secure: true, httpOnly: false },
      ];
      await injectCookiesViaTransient(cdp.wsUrl, cookies, 3_000);
      // Round-trip read should show what we just set.
      const out = await captureCookiesViaTransient(cdp.wsUrl, 3_000);
      expect(out[0]!.name).toBe("k");
    } finally {
      await cdp.close();
    }
  });

  it("rejects with a timeout error when the peer hangs", async () => {
    const cdp = await startMockCdp();
    try {
      cdp.setHangsOnSend();
      const cookies: CdpCookie[] = [
        { name: "k", value: "v", domain: ".x", path: "/", secure: true, httpOnly: false },
      ];
      await expect(
        injectCookiesViaTransient(cdp.wsUrl, cookies, 200),
      ).rejects.toThrow(/injectCookiesViaTransient timeout after 200ms/);
    } finally {
      await cdp.close();
    }
  });
});
