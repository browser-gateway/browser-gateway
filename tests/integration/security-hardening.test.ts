import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TOKEN = "test-token-32chars-long-abcdefgh";
const configPath = join(tmpdir(), `gateway-hardening-${process.pid}.yml`);
const webDir = join(tmpdir(), `gateway-hardening-web-${process.pid}`);
mkdirSync(webDir, { recursive: true });
writeFileSync(join(webDir, "index.html"), "<html />", "utf-8");
writeFileSync(configPath, "version: 1\nproviders: {}\n", "utf-8");

vi.mock("../../src/server/config/loader.js", () => ({ loadedConfigPath: configPath }));
vi.mock("../../src/server/config/writer.js", () => ({ writeConfig: () => undefined }));

const { Gateway } = await import("../../src/core/gateway.js");
const { createApp } = await import("../../src/server/app.js");
const { GatewayConfigSchema } = await import("../../src/core/types.js");

type GatewayT = InstanceType<typeof Gateway>;
let gateway: GatewayT;

beforeAll(() => {
  const config = GatewayConfigSchema.parse({
    providers: {
      secret: {
        url: "wss://user:PASSWORD@provider.example/?apiKey=PROVIDER_SECRET",
        headers: { Authorization: "Bearer PROVIDER_BEARER", "X-Region": "eu" },
        limits: { maxConcurrent: 1 },
        priority: 1,
      },
    },
  });
  gateway = new Gateway(config, pino({ level: "silent" }));
});

afterAll(async () => {
  await gateway.gracefulShutdown();
  try { unlinkSync(configPath); } catch { /* ok */ }
  try { rmSync(webDir, { recursive: true, force: true }); } catch { /* ok */ }
});

function build() {
  return createApp(gateway, TOKEN, webDir, pino({ level: "silent" }));
}

function buildOpen() {
  return createApp(gateway, undefined, webDir, pino({ level: "silent" }));
}

describe("mutating request guard", () => {
  it("rejects a POST body sent as text/plain with 415", async () => {
    const res = await buildOpen().request("/v1/providers", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ id: "evil", url: "wss://evil.tld/cdp", priority: 0 }),
    });
    expect(res.status).toBe(415);
    expect(gateway.config.providers.evil).toBeUndefined();
  });

  it("rejects a POST body sent with no Content-Type with 415", async () => {
    const res = await buildOpen().request("/v1/providers", {
      method: "POST",
      body: JSON.stringify({ id: "evil2", url: "wss://evil.tld/cdp", priority: 0 }),
    });
    expect(res.status).toBe(415);
    expect(gateway.config.providers.evil2).toBeUndefined();
  });

  it("rejects a cross-site mutating request with 403", async () => {
    const res = await buildOpen().request("/v1/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
      body: JSON.stringify({ id: "evil3", url: "wss://evil.tld/cdp", priority: 0 }),
    });
    expect(res.status).toBe(403);
    expect(gateway.config.providers.evil3).toBeUndefined();
  });

  it("lets a same-origin JSON request through the guard", async () => {
    const res = await build().request("/v1/providers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("leaves reads untouched", async () => {
    const res = await buildOpen().request("/v1/status", { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(res.status).toBe(200);
  });
});

describe("GET /v1/providers credential redaction", () => {
  it("masks userinfo and secret query params in the provider URL", async () => {
    const res = await build().request("/v1/providers", { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = await res.json() as { providers: { url: string }[] };
    expect(body.providers[0]!.url).not.toContain("PASSWORD");
    expect(body.providers[0]!.url).not.toContain("PROVIDER_SECRET");
  });

  it("masks credential-bearing headers and keeps the rest", async () => {
    const res = await build().request("/v1/providers", { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = await res.json() as { providers: { headers: Record<string, string> }[] };
    expect(body.providers[0]!.headers.Authorization).toBe("***");
    expect(body.providers[0]!.headers["X-Region"]).toBe("eu");
  });
});

describe("multiProfile on external providers", () => {
  it("rejects multiProfile:true on PUT", async () => {
    const res = await build().request("/v1/providers/secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ multiProfile: true }),
    });
    expect(res.status).toBe(400);
    expect(gateway.config.providers.secret!.multiProfile).not.toBe(true);
  }, 30000);
});

describe("dashboard session lifetime", () => {
  async function login(app: ReturnType<typeof build>): Promise<string> {
    const res = await app.request("/web/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    const setCookie = res.headers.get("set-cookie")!;
    return setCookie.split(";")[0]!;
  }

  it("accepts a fresh cookie", async () => {
    const app = build();
    const cookie = await login(app);
    const res = await app.request("/web/auth/check", { headers: { cookie } });
    expect(await res.json()).toEqual({ authenticated: true, authRequired: true });
  });

  it("rejects a cookie older than the max age", async () => {
    const app = build();
    const cookie = await login(app);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31 * 24 * 60 * 60 * 1000);
    try {
      const res = await app.request("/web/auth/check", { headers: { cookie } });
      expect(await res.json()).toEqual({ authenticated: false, authRequired: true });
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it("invalidates issued cookies server-side on logout", async () => {
    const app = build();
    const cookie = await login(app);
    await app.request("/web/logout", { method: "POST" });
    const res = await app.request("/web/auth/check", { headers: { cookie } });
    expect(await res.json()).toEqual({ authenticated: false, authRequired: true });
  });

  it("refuses the token in a query string on HTTP routes", async () => {
    const res = await build().request(`/v1/status?token=${TOKEN}`);
    expect(res.status).toBe(401);
  });
});
