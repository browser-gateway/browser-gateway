import { randomBytes } from "node:crypto";
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

describe("/v1/config secret redaction", () => {
  it("redacts provider tokens for Bearer callers", async () => {
    const app = build();
    const res = await app.request("/v1/config", { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = await res.json() as { yaml: string; redacted: boolean };
    expect(body.redacted).toBe(true);
    expect(body.yaml).not.toContain("SECRET_PROVIDER_TOKEN");
    expect(body.yaml).toContain("wss://browserless.io/?***");
  });

  it("redacts webhook signing secrets and credential headers for Bearer callers", async () => {
    const app = build();
    const res = await app.request("/v1/config", { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = await res.json() as { yaml: string };
    expect(body.yaml).not.toContain(FILE_SECRET);
    expect(body.yaml).not.toContain("SECRET_HEADER_TOKEN");
    expect(body.yaml).toMatch(/secret: "?\*\*\*"?/);
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

describe("redacted config view", () => {
  it("hides credentials in wrapped, folded and one-line YAML", async () => {
    const FLOW_SECRET = `whsec_${randomBytes(32).toString("base64")}`;
    const FOLDED_SECRET = `whsec_${randomBytes(32).toString("base64")}`;
    const { redactConfigYaml } = await import("../../src/server/config/redact-config.js");
    const longToken = "L".repeat(130);
    const yaml = [
      "webhooks:",
      `  - {url: https://hooks.example/in, secret: ${FLOW_SECRET}}`,
      "providers:",
      "  a:",
      "    url: wss://a.example/",
      "    headers: {Authorization: \"Bearer FLOWHEADER\"}",
      "  b:",
      "    url: wss://b.example/",
      "    headers:",
      "      Authorization: >-",
      `        Bearer ${longToken}`,
      "      Cookie: sid=COOKIEVALUE",
      "      Proxy-Authorization: Basic PROXYVALUE",
      "extra:",
      "  secret: >-",
      `    ${FOLDED_SECRET}`,
    ].join("\n");
    const out = redactConfigYaml(yaml);
    for (const leaked of [FLOW_SECRET, "FLOWHEADER", longToken.slice(0, 20), "COOKIEVALUE", "PROXYVALUE", FOLDED_SECRET]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain("wss://a.example/");
  });

  it("masks connection addresses that start with spaces", async () => {
    const { redactConfigYaml } = await import("../../src/server/config/redact-config.js");
    const out = redactConfigYaml(`providers:\n  a:\n    url: " wss://u:PASSVALUE@browser.example/?token=TOKENVALUE"\n`);
    expect(out).not.toContain("PASSVALUE");
    expect(out).not.toContain("TOKENVALUE");
  });

  it("refuses to save the masked view back over the real credentials", async () => {
    const { readFileSync } = await import("node:fs");
    const before = readFileSync(configPath, "utf-8");
    const app = build();
    const view = await (await app.request("/v1/config", { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as { yaml: string };
    expect(view.yaml).toContain("***");
    const save = await app.request("/v1/config", {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ yaml: view.yaml }),
    });
    expect(save.status).toBe(400);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("refuses a save whose only masked values are provider credentials", async () => {
    const { readFileSync } = await import("node:fs");
    const before = readFileSync(configPath, "utf-8");
    const yaml = [
      "version: 1",
      "providers:",
      "  a:",
      "    url: wss://browser.example/?token=***",
      "    headers:",
      '      Authorization: "***"',
      "    priority: 1",
    ].join("\n");
    const save = await build().request("/v1/config", {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ yaml }),
    });
    expect(save.status).toBe(400);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("masks credentials in addresses inside ordinary headers and in disguised addresses", async () => {
    const { redactConfigYaml } = await import("../../src/server/config/redact-config.js");
    const out = redactConfigYaml([
      "providers:",
      "  a:",
      '    url: "ws\\ts://USER:PASSX@host/?%74oken=TOKENX"',
      "    headers:",
      "      Referer: https://u:PASSY@host/?token=TOKENY",
      '      Link: "<https://host/?%74oken=TOKENZ>; rel=next"',
      "      X-Note: \"see https://host/?q='a'&%74oken=TOKENQ\"",
      "      Accept: json",
    ].join("\n"));
    for (const leaked of ["PASSX", "TOKENX", "PASSY", "TOKENY", "TOKENZ", "TOKENQ"]) expect(out).not.toContain(leaked);
    expect(out).not.toContain("Accept: json");
  });

  it("hides a value whose credential survives masking only in encoded or cut-short form", async () => {
    const { redactConfigYaml } = await import("../../src/server/config/redact-config.js");
    const out = redactConfigYaml([
      "providers:",
      "  a:",
      '    url: "https://host/?next=https%3A%2F%2Fuser%3APASSNESTED%40inner/"',
      "    note: \"see https://host/?q=<value>&%74oken=TOKENCUT\"",
      "  b:",
      "    url: wss://plain.example/?region=eu",
    ].join("\n"));
    expect(out).not.toContain("PASSNESTED");
    expect(out).not.toContain("TOKENCUT");
    expect(out).toContain("wss://plain.example/?***");
  });

  it("shows only the scheme and host of an address, so odd encodings cannot carry a credential through", async () => {
    const { redactConfigYaml, configHasMaskedValues } = await import("../../src/server/config/redact-config.js");
    const out = redactConfigYaml([
      "providers:",
      "  a:",
      "    url: wss://browser.example/?next=https%3A%2F%2Fuser%3APASSLEAK%40inner.example%2F&other=%",
      "  b:",
      "    url: wss://browser.example/?next=https%25252525253A%25252525252F%25252525252Fuser%25252525253APASSLEAK%252525252540inner.example%25252525252F",
      "  c:",
      "    url: wss://host/?next=%3Ftoken%3D%2A%2A%2ATOKENLEAK",
      "  d:",
      "    url: wss://plain.example/",
      "    region: eu",
    ].join("\n"));
    expect(out).not.toMatch(/LEAK/);
    expect(out).toContain("wss://plain.example/");
    expect(out).toContain("region: eu");
    expect(configHasMaskedValues(out)).toBe(true);
    expect(configHasMaskedValues(redactConfigYaml("a: ["))).toBe(true);
    const login = redactConfigYaml("providers:\n  a:\n    url: wss://alice:PASSVALUE@browser.example/\n");
    expect(login).not.toContain("PASSVALUE");
    expect(configHasMaskedValues(login)).toBe(true);
  });

  it("shows nothing when the file cannot be parsed", async () => {
    const { redactConfigYaml } = await import("../../src/server/config/redact-config.js");
    expect(redactConfigYaml("token: SECRETVALUE\n  bad: [")).not.toContain("SECRETVALUE");
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
