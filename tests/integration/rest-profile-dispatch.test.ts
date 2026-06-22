/**
 * Tier 2 integration test for the REST `profile` field dispatch.
 *
 * Verifies:
 *   - Sending `profile: "x"` to /v1/screenshot when profiles are DISABLED
 *     returns 400 with the expected error (not 500, not a generic ZodError).
 *   - The Zod schema accepts a valid `profile` field on all three endpoints
 *     and rejects an invalid one (regex mismatch) with a 400.
 *
 * We don't exercise the actual playwright pipeline here — that's covered by
 * the existing `profile-rest.test.ts` for the WebSocket path and would
 * require a real Chrome provider to test the REST profile-pinned flow
 * end-to-end (tier 3). Those tier 3 tests live in the project-root tests/
 * folder.
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
      mock: { url: "http://127.0.0.1:1", limits: { maxConcurrent: 1 }, priority: 1 },
    },
  });
  const gateway = new Gateway(config, pino({ level: "silent" }));
  const pool = new SessionPool(0, pino({ level: "silent" }), {
    minSessions: 0,
    maxSessions: 1,
    maxPagesPerSession: 1,
    retireAfterPages: 1,
    retireAfterMs: 1000,
    idleTimeoutMs: 1000,
    pageTimeoutMs: 1000,
  });
  app = createApp(gateway, undefined, undefined, pino({ level: "silent" }), pool);
});

describe("REST profile dispatch — feature disabled", () => {
  it("/v1/screenshot with profile field returns 400 (not 500) when profiles disabled", async () => {
    const res = await app.request("/v1/screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", profile: "acme" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/profiles are not enabled/i);
    expect(body.error).toMatch(/gateway\.yml/);
  });

  it("/v1/content with profile field returns 400 when profiles disabled", async () => {
    const res = await app.request("/v1/content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", profile: "acme" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/profiles are not enabled/i);
  });

  it("/v1/scrape with profile field returns 400 when profiles disabled", async () => {
    const res = await app.request("/v1/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com",
        profile: "acme",
        selectors: [{ name: "title", selector: "h1" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/profiles are not enabled/i);
  });
});

describe("REST profile dispatch — schema validation", () => {
  it("rejects an invalid profile id (regex mismatch) with 400", async () => {
    const res = await app.request("/v1/screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", profile: "-bad-start" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details?: string[] };
    // Should be a Zod validation error, not the disabled-feature one
    expect(body.error).toBe("Validation error");
    expect(JSON.stringify(body.details ?? [])).toMatch(/profile/i);
  });

  it("rejects a too-long profile id with 400", async () => {
    const tooLong = "a".repeat(129);
    const res = await app.request("/v1/screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", profile: tooLong }),
    });
    expect(res.status).toBe(400);
  });
});
