/**
 * Verifies the REST behaviour when the profiles feature is OFF.
 *
 * Catches the regression where /v1/profiles fell through to the catch-all and
 * returned 503 "No providers configured", which broke the dashboard's
 * Profiles page for users who hadn't enabled the feature.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { Hono } from "hono";
import pino from "pino";
import { Gateway } from "../../src/core/gateway.js";
import { createApp } from "../../src/server/app.js";
import { SessionPool } from "../../src/core/pool/index.js";
import { GatewayConfigSchema } from "../../src/core/types.js";

let app: Hono;

beforeAll(() => {
  const config = GatewayConfigSchema.parse({
    providers: {
      "test-provider": {
        url: "ws://localhost:9999",
        limits: { maxConcurrent: 4 },
        priority: 1,
      },
    },
    // profiles intentionally not configured → defaults to enabled: false
  });
  const gateway = new Gateway(config, pino({ level: "silent" }));
  // Pass undefined for `profile` → triggers the disabled-routes path.
  app = createApp(gateway, undefined, undefined, pino({ level: "silent" }));
});

describe("Profile REST when feature is disabled", () => {
  it("GET /v1/profiles returns 200 with enabled: false and an empty list", async () => {
    const res = await app.request("/v1/profiles");
    expect(res.status).toBe(200);
    const body = await res.json() as { enabled: boolean; count: number; profiles: unknown[]; reason: string };
    expect(body.enabled).toBe(false);
    expect(body.count).toBe(0);
    expect(body.profiles).toEqual([]);
    expect(body.reason).toMatch(/enable profiles\b/i);
  });

  it("GET /v1/profiles/:id returns 404 (no profile can exist when disabled)", async () => {
    const res = await app.request("/v1/profiles/some-id");
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; reason: string };
    expect(body.reason).toMatch(/enable profiles\b/i);
  });

  it("DELETE /v1/profiles/:id returns 400 with a clear disabled reason", async () => {
    const res = await app.request("/v1/profiles/x", { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; reason: string };
    expect(body.error).toBe("Profiles disabled");
    expect(body.reason).toMatch(/enable profiles\b/i);
  });

  it("POST /v1/profiles/import returns 400", async () => {
    const res = await app.request("/v1/profiles/import", {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(400);
  });

  it("GET /v1/profiles/:id/export returns 400", async () => {
    const res = await app.request("/v1/profiles/x/export");
    expect(res.status).toBe(400);
  });

  // Regression-pin: this used to be 503 "No providers configured" which is the
  // exact mis-routing the user reported.
  it("does NOT return 503 — disabled is configuration, not an outage", async () => {
    const res = await app.request("/v1/profiles");
    expect(res.status).not.toBe(503);
  });
});

describe("Profile REST when zero providers AND profiles disabled (the exact user-reported bug)", () => {
  let appNoProviders: Hono;
  let appNoProvidersWithPool: Hono;

  beforeAll(() => {
    const config = GatewayConfigSchema.parse({
      providers: {}, // no providers — used to trigger the rest "*" wildcard 503
    });
    const gateway = new Gateway(config, pino({ level: "silent" }));
    appNoProviders = createApp(gateway, undefined, undefined, pino({ level: "silent" }));

    // Also test the path with a pool (which mounts the REST action routes, where
    // the rogue wildcard middleware lived). Without pool, REST routes aren't
    // mounted at all and the bug couldn't repro.
    const gateway2 = new Gateway(
      GatewayConfigSchema.parse({ providers: {} }),
      pino({ level: "silent" }),
    );
    // We need a SessionPool to mount the REST action routes. Pool itself isn't
    // exercised — the gate fires before any pool usage when no providers exist.
    const pool = new SessionPool(0, pino({ level: "silent" }), {
      minSessions: 0,
      maxSessions: 0,
      maxPagesPerSession: 1,
      retireAfterPages: 1,
      retireAfterMs: 1000,
      idleTimeoutMs: 1000,
      pageTimeoutMs: 1000,
    });
    appNoProvidersWithPool = createApp(gateway2, undefined, undefined, pino({ level: "silent" }), pool);
  });

  it("GET /v1/profiles returns 200 even when zero providers + no pool", async () => {
    const res = await appNoProviders.request("/v1/profiles");
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(503);
  });

  it("GET /v1/profiles returns 200 even when zero providers + pool mounted", async () => {
    const res = await appNoProvidersWithPool.request("/v1/profiles");
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(503);
  });

  it("the action routes (/v1/screenshot etc.) DO still return 503 when no providers", async () => {
    const res = await appNoProvidersWithPool.request("/v1/screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("No providers configured");
  });
});
