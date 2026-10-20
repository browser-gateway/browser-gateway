import { describe, expect, it } from "vitest";
import { ProxyConfigSchema, buildProxyConfig, describeProxies, isAllowedResourceName, isDirectBrowserProxy, parseProxyUrl } from "../../src/core/proxy-config.js";
import { isEligibleProviderForProxy } from "../../src/core/providers/effective.js";
import { GatewayConfigSchema } from "../../src/core/types.js";

function ok(raw: string, opts = {}) {
  const r = parseProxyUrl(raw, opts);
  if (!r.ok) throw new Error(r.reason);
  return r.proxy;
}

describe("parseProxyUrl", () => {
  it("parses credentials, port and the credential-free server form", () => {
    const p = ok("http://user:p%40ss@proxy.example.com:8080");
    expect(p).toMatchObject({ scheme: "http", host: "proxy.example.com", port: 8080, username: "user", password: "p@ss" });
    expect(p.server).toBe("http://proxy.example.com:8080");
  });

  it("fills the default port per scheme", () => {
    expect(ok("https://p.example.com").port).toBe(443);
    expect(ok("socks5://p.example.com").port).toBe(1080);
    expect(ok("http://p.example.com").port).toBe(80);
  });

  it("refuses schemes outside the allowlist", () => {
    for (const raw of ["ftp://p.example.com:21", "file:///etc/passwd", "ws://p.example.com", "javascript:alert(1)"]) {
      expect(parseProxyUrl(raw).ok, raw).toBe(false);
    }
  });

  it("parses socks5 with a login, which a browser cannot use directly", () => {
    const r = parseProxyUrl("socks5://u:p@p.example.com:1080");
    expect(r.ok && r.proxy.username === "u" && r.proxy.password === "p").toBe(true);
    expect(r.ok && isDirectBrowserProxy(r.proxy)).toBe(false);
    const plain = parseProxyUrl("socks5h://p.example.com:1080");
    expect(plain.ok && isDirectBrowserProxy(plain.proxy)).toBe(true);
  });

  it("refuses a path, query or fragment", () => {
    for (const raw of ["http://p.example.com:8080/x", "http://p.example.com:8080?a=1", "http://p.example.com:8080#f"]) {
      expect(parseProxyUrl(raw).ok, raw).toBe(false);
    }
  });

  it("refuses private hosts only when asked", () => {
    for (const raw of ["http://127.0.0.1:3128", "http://169.254.169.254:80", "http://10.0.0.5:3128", "http://[::ffff:169.254.169.254]:80", "http://localhost:3128"]) {
      expect(parseProxyUrl(raw).ok, raw).toBe(true);
      expect(parseProxyUrl(raw, { rejectPrivateHosts: true }).ok, raw).toBe(false);
    }
    expect(parseProxyUrl("http://proxy.example.com:3128", { rejectPrivateHosts: true }).ok).toBe(true);
  });

  it("never echoes the input, including its password, in the reason", () => {
    const r = parseProxyUrl("ftp://user:hunter2-secret@p.example.com:21");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toContain("hunter2");
    const long = parseProxyUrl(`http://user:${"x".repeat(3000)}@p.example.com:1`);
    expect(long.ok).toBe(false);
  });
});

describe("isDirectBrowserProxy", () => {
  it("is true only for credential-free, non-https proxies", () => {
    expect(isDirectBrowserProxy(ok("http://p.example.com:3128"))).toBe(true);
    expect(isDirectBrowserProxy(ok("socks5://p.example.com:1080"))).toBe(true);
    expect(isDirectBrowserProxy(ok("http://u:p@p.example.com:3128"))).toBe(false);
    expect(isDirectBrowserProxy(ok("https://p.example.com:443"))).toBe(false);
  });
});

describe("isEligibleProviderForProxy", () => {
  const direct = ok("http://p.example.com:3128");
  it("passes every provider when no proxy is requested", () => {
    expect(isEligibleProviderForProxy({}, null)).toBe(true);
    expect(isEligibleProviderForProxy({ injectProxy: false }, null)).toBe(true);
  });
  it("passes only browsers marked injectProxy, and only for direct proxies", () => {
    expect(isEligibleProviderForProxy({}, direct)).toBe(false);
    expect(isEligibleProviderForProxy({ injectProxy: true }, direct)).toBe(true);
    expect(isEligibleProviderForProxy({ injectProxy: true }, ok("http://u:p@p.example.com:3128"))).toBe(false);
  });
});

describe("config schema", () => {
  it("defaults proxies to empty so existing configs parse unchanged", () => {
    const cfg = GatewayConfigSchema.parse({ providers: { a: { url: "ws://localhost:9222" } } });
    expect(cfg.proxies).toEqual({});
    expect(cfg.providers.a!.injectProxy).toBeUndefined();
  });
  it("rejects an invalid proxy at load time", () => {
    expect(ProxyConfigSchema.safeParse({ url: "ftp://u:p@h:1" }).success).toBe(false);
    expect(ProxyConfigSchema.safeParse({ url: "http://h:3128", bypass: ["*.internal"] }).success).toBe(true);
  });
});

describe("describeProxies", () => {
  it("shows address and bypass without credentials and flags proxies a browser cannot apply", () => {
    const out = describeProxies({
      plain: { url: "http://10.1.2.3:3128", bypass: ["*.internal"] },
      locked: { url: "http://alice:hunter2@proxy.example.com:8080" },
      tls: { url: "https://proxy.example.com" },
      broken: { url: "ftp://x" },
    });
    expect(JSON.stringify(out)).not.toMatch(/alice|hunter2/);
    expect(out).toEqual([
      { name: "plain", server: "http://10.1.2.3:3128", bypass: ["*.internal"], usable: true, hasCredentials: false },
      expect.objectContaining({ name: "locked", server: "http://proxy.example.com:8080", usable: false, hasCredentials: true }),
      expect.objectContaining({ name: "tls", usable: false }),
      expect.objectContaining({ name: "broken", server: null, usable: false }),
    ]);
  });
});

describe("buildProxyConfig", () => {
  const saved = { url: "http://alice:p%40ss@proxy.example.com:8080" };
  function built(input: Parameters<typeof buildProxyConfig>[0], existing?: { url: string }) {
    const r = buildProxyConfig(input, existing);
    if (!r.ok) throw new Error(r.reason);
    return r.config;
  }

  it("builds a stored url from separate fields and encodes the password", () => {
    expect(built({ address: "http://proxy.example.com:8080", username: "bob", password: "a b@c" }).url).toBe("http://bob:a%20b%40c@proxy.example.com:8080");
    expect(built({ address: " socks5://10.0.0.2:1080 ", bypass: [" *.internal ", ""] })).toEqual({ url: "socks5://10.0.0.2:1080", bypass: ["*.internal"] });
  });

  it("keeps the saved username and password when the fields are left empty", () => {
    expect(built({ address: "http://other.example.com:3128", username: "", password: "" }, saved).url).toBe("http://alice:p%40ss@other.example.com:3128");
  });

  it("replaces the password when a new one is typed, and drops both when cleared", () => {
    expect(built({ address: "http://proxy.example.com:8080", password: "new" }, saved).url).toBe("http://alice:new@proxy.example.com:8080");
    expect(built({ address: "http://proxy.example.com:8080", clearCredentials: true }, saved).url).toBe("http://proxy.example.com:8080");
  });

  it("refuses an invalid address without echoing it", () => {
    const r = buildProxyConfig({ address: "ftp://proxy.example.com:1080", password: "hunter2" });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("hunter2");
    expect(buildProxyConfig({ address: "not a url" }).ok).toBe(false);
  });
});

describe("reserved names", () => {
  it("refuses none in any case and names outside the allowed characters", () => {
    for (const bad of ["none", "None", "", "a b", "x".repeat(65)]) expect(isAllowedResourceName(bad), bad).toBe(false);
    expect(isAllowedResourceName("home-proxy_1")).toBe(true);
  });
  it("refuses a proxy named none in the config file", () => {
    expect(GatewayConfigSchema.safeParse({ providers: {}, proxies: { none: { url: "http://h:3128" } } }).success).toBe(false);
  });
});
