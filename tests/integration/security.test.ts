/**
 * Security-fix tests for the 0.3.1 hardening pass. Covers:
 *
 *   - Security headers on every response
 *   - CORS allowlist (off by default; on via BG_ALLOWED_ORIGINS)
 *   - /json/version respects X-Forwarded-Proto
 *   - /v1/auth/info only returns BG_TOKEN to cookie-auth callers
 *   - /v1/config GET redacts provider tokens for Bearer-auth callers
 *   - Cookie Secure flag follows X-Forwarded-Proto, not the request URL
 */
import { afterAll, beforeEach, beforeAll, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TOKEN = "test-token-32chars-long-abcdefgh";
const configPath = join(tmpdir(), `gateway-security-${process.pid}.yml`);
const webDir = join(tmpdir(), `gateway-security-web-${process.pid}`);
mkdirSync(webDir, { recursive: true });
writeFileSync(join(webDir, "index.html"), "<html />", "utf-8");

writeFileSync(
  configPath,
  `version: 1
providers:
  provider-a:
    url: wss://browserless.io/?token=SECRET_PROVIDER_TOKEN
    limits:
      maxConcurrent: 5
    priority: 1
`,
  "utf-8",
);

vi.mock("../../src/server/config/loader.js", () => ({ loadedConfigPath: configPath }));

const { Gateway } = await import("../../src/core/gateway.js");
const { createApp } = await import("../../src/server/app.js");
const { GatewayConfigSchema } = await import("../../src/core/types.js");

type GatewayT = InstanceType<typeof Gateway>;
let gateway: GatewayT;

beforeAll(async () => {
  const config = GatewayConfigSchema.parse({
    providers: { stub: { url: "ws://localhost:9999", limits: { maxConcurrent: 1 }, priority: 1 } },
  });
  gateway = new Gateway(config, pino({ level: "silent" }));
});

afterAll(async () => {
  await gateway.gracefulShutdown();
  try { unlinkSync(configPath); } catch { /* ok */ }
  try { rmSync(webDir, { recursive: true, force: true }); } catch { /* ok */ }
});

beforeEach(() => {
  delete process.env.BG_ALLOWED_ORIGINS;
});

function build() {
  return createApp(gateway, TOKEN, webDir, pino({ level: "silent" }));
}

describe("security headers", () => {
  it("emits nosniff, X-Frame-Options, Referrer-Policy on /health", async () => {
    const app = build();
    const res = await app.request("/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });

  it("only emits HSTS when behind X-Forwarded-Proto=https", async () => {
    const app = build();
    const plain = await app.request("/health");
    expect(plain.headers.get("strict-transport-security")).toBeNull();
    const tls = await app.request("/health", { headers: { "X-Forwarded-Proto": "https" } });
    expect(tls.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
  });
});

describe("CORS allowlist", () => {
  it("does NOT add Access-Control-Allow-Origin by default", async () => {
    const app = build();
    const res = await app.request("/health", { headers: { Origin: "https://attacker.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows whitelisted origin when BG_ALLOWED_ORIGINS is set", async () => {
    process.env.BG_ALLOWED_ORIGINS = "https://app.example,https://dash.example";
    const app = build();
    const res = await app.request("/health", { headers: { Origin: "https://app.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });

  it("rejects non-whitelisted origin even when allowlist is set", async () => {
    process.env.BG_ALLOWED_ORIGINS = "https://app.example";
    const app = build();
    const res = await app.request("/health", { headers: { Origin: "https://attacker.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("/json/version proto detection", () => {
  it("returns wss:// when X-Forwarded-Proto: https", async () => {
    const app = build();
    const res = await app.request("/json/version", {
      headers: { "X-Forwarded-Proto": "https", host: "gw.example" },
    });
    const body = await res.json() as { webSocketDebuggerUrl: string };
    expect(body.webSocketDebuggerUrl).toBe("wss://gw.example/v1/connect");
  });

  it("returns ws:// when no proxy header (plain HTTP)", async () => {
    const app = build();
    const res = await app.request("/json/version", { headers: { host: "gw.example" } });
    const body = await res.json() as { webSocketDebuggerUrl: string };
    expect(body.webSocketDebuggerUrl).toBe("ws://gw.example/v1/connect");
  });

  it("uses X-Forwarded-Host when set (Railway, Render, etc.)", async () => {
    const app = build();
    const res = await app.request("/json/version", {
      headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "gw.example.com", host: "internal-1.railway:9500" },
    });
    const body = await res.json() as { webSocketDebuggerUrl: string };
    expect(body.webSocketDebuggerUrl).toBe("wss://gw.example.com/v1/connect");
  });
});

describe("/v1/auth/info", () => {
  it("returns null token for Bearer-only callers", async () => {
    const app = build();
    const res = await app.request("/v1/auth/info", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = await res.json() as { token: string | null; authEnabled: boolean };
    expect(body.authEnabled).toBe(true);
    expect(body.token).toBeNull();
  });

  it("returns the real token for cookie-session callers", async () => {
    const app = build();
    // Establish a session by POST /web/auth
    const login = await app.request("/web/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie")!;
    const cookieValue = setCookie.split(";")[0]; // bg_session=...

    const res = await app.request("/v1/auth/info", { headers: { Cookie: cookieValue } });
    const body = await res.json() as { token: string | null; authEnabled: boolean };
    expect(body.authEnabled).toBe(true);
    expect(body.token).toBe(TOKEN);
  });
});

describe("/v1/config secret redaction", () => {
  it("redacts provider tokens for Bearer callers", async () => {
    const app = build();
    const res = await app.request("/v1/config", { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = await res.json() as { yaml: string; redacted: boolean };
    expect(body.redacted).toBe(true);
    expect(body.yaml).not.toContain("SECRET_PROVIDER_TOKEN");
    expect(body.yaml).toContain("token=***");
  });

  it("returns raw YAML for cookie-session callers", async () => {
    const app = build();
    const login = await app.request("/web/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    const cookieValue = login.headers.get("set-cookie")!.split(";")[0];

    const res = await app.request("/v1/config", { headers: { Cookie: cookieValue } });
    const body = await res.json() as { yaml: string; redacted: boolean };
    expect(body.redacted).toBe(false);
    expect(body.yaml).toContain("SECRET_PROVIDER_TOKEN");
  });
});

describe("cookie Secure flag", () => {
  it("sets Secure when behind X-Forwarded-Proto=https", async () => {
    const app = build();
    const res = await app.request("/web/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("omits Secure on plain HTTP (allows localhost dev)", async () => {
    const app = build();
    const res = await app.request("/web/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).not.toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
  });
});
