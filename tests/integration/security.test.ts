import { randomBytes } from "node:crypto";
/**
 * Security-fix tests for the 0.3.1 hardening pass. Covers:
 *
 *   - Security headers on every response
 *   - CORS allowlist (off by default; on via BG_ALLOWED_ORIGINS)
 *   - /json/version respects X-Forwarded-Proto
 *   - /v1/auth/info only returns BG_TOKEN to cookie-auth callers
 *   - /v1/config GET returns the file only to a signed-in dashboard session
 *   - Cookie Secure flag follows X-Forwarded-Proto, not the request URL
 */
import { afterAll, beforeEach, beforeAll, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TOKEN = "test-token-32chars-long-abcdefgh";
const FILE_SECRET = `whsec_${randomBytes(32).toString("base64")}`;
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
    headers:
      Authorization: Bearer SECRET_HEADER_TOKEN
    limits:
      maxConcurrent: 5
    priority: 1
webhooks:
  - url: https://hooks.example/in
    secret: ${FILE_SECRET}
`,
  "utf-8",
);

vi.mock("../../src/server/config/loader.js", async (orig) => ({ ...(await orig<object>()), loadedConfigPath: configPath }));

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
  it("emits nosniff, X-Frame-Options, Referrer-Policy on /json/version", async () => {
    const app = build();
    const res = await app.request("/json/version");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });

  it("only emits HSTS when behind X-Forwarded-Proto=https", async () => {
    const app = build();
    const plain = await app.request("/json/version");
    expect(plain.headers.get("strict-transport-security")).toBeNull();
    const tls = await app.request("/json/version", { headers: { "X-Forwarded-Proto": "https" } });
    expect(tls.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
  });

  it("skips ALL security headers on /health so infra probes (Railway/k8s) aren't confused", async () => {
    const app = build();
    const res = await app.request("/health", { headers: { "X-Forwarded-Proto": "https" } });
    expect(res.headers.get("x-content-type-options")).toBeNull();
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("strict-transport-security")).toBeNull();
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

describe("/v1/config is shown only to a signed-in dashboard", () => {
  async function read(app: ReturnType<typeof build>, headers: Record<string, string>) {
    const res = await app.request("/v1/config", { headers });
    return { status: res.status, text: await res.text() };
  }

  it("hides the whole file from token callers", async () => {
    const { status, text } = await read(build(), { Authorization: `Bearer ${TOKEN}` });
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual({ yaml: "", path: null, exists: true, hidden: true });
    for (const leaked of ["SECRET_PROVIDER_TOKEN", "SECRET_HEADER_TOKEN", FILE_SECRET, configPath]) expect(text).not.toContain(leaked);
  });

  it("hides the whole file when the gateway has no token", async () => {
    const { text } = await read(createApp(gateway, undefined, webDir, pino({ level: "silent" })), {});
    expect(JSON.parse(text)).toMatchObject({ yaml: "", hidden: true });
    expect(text).not.toContain("SECRET_PROVIDER_TOKEN");
  });

  it("returns the real file to a signed-in dashboard session", async () => {
    const app = build();
    const login = await app.request("/web/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    const cookieValue = login.headers.get("set-cookie")!.split(";")[0]!;
    const body = JSON.parse((await read(app, { Cookie: cookieValue })).text) as { yaml: string; hidden: boolean };
    expect(body.hidden).toBe(false);
    expect(body.yaml).toContain("SECRET_PROVIDER_TOKEN");
  });

  it("refuses to save a config that still holds a masked value", async () => {
    const { readFileSync } = await import("node:fs");
    const before = readFileSync(configPath, "utf-8");
    const yaml = ["version: 1", "providers:", "  a:", "    url: wss://browser.example/?token=***", "    priority: 1"].join("\n");
    const save = await build().request("/v1/config", {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ yaml }),
    });
    expect(save.status).toBe(400);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
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

describe("editing a webhook", () => {
  it("keeps its signing secret when the edit does not send one", async () => {
    const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
    gateway.config.webhooks.push({ url: "https://hooks.example/a", secret });
    const index = gateway.config.webhooks.length - 1;
    const app = build();
    const res = await app.request(`/v1/webhooks/${index}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://hooks.example/b", events: ["provider.down"] }),
    });
    expect(res.status).toBe(200);
    expect(gateway.config.webhooks[index]).toEqual({ url: "https://hooks.example/b", events: ["provider.down"], secret });
    const list = await (await app.request("/v1/webhooks", { headers: { Authorization: `Bearer ${TOKEN}` } })).text();
    expect(list).not.toContain(secret);
  });
});

describe("editing a webhook whose address carries a token", () => {
  it("keeps the real address when the masked one is sent back, and refuses other masked addresses", async () => {
    gateway.config.webhooks.push({ url: "https://hooks.example/in?token=REALTOKEN" });
    const index = gateway.config.webhooks.length - 1;
    const app = build();
    const list = await (await app.request("/v1/webhooks", { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as { webhooks: { index: number; url: string }[] };
    const masked = list.webhooks.find((w) => w.index === index)!.url;
    expect(masked).not.toContain("REALTOKEN");
    const put = (url: string) =>
      app.request(`/v1/webhooks/${index}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url, events: ["provider.down"] }),
      });
    expect((await put(masked)).status).toBe(200);
    expect(gateway.config.webhooks[index]!.url).toBe("https://hooks.example/in?token=REALTOKEN");
    expect((await put("https://other.example/in?token=***")).status).toBe(400);
    expect(gateway.config.webhooks[index]!.url).toBe("https://hooks.example/in?token=REALTOKEN");
  });
});
