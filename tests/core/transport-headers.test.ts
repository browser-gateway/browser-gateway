import { describe, it, expect } from "vitest";
import { resolveProviderOutbound } from "../../src/core/transport.js";

describe("resolveProviderOutbound", () => {
  it("passes through headers with clean URL when neither userinfo nor Authorization present", () => {
    const out = resolveProviderOutbound("wss://provider.example.com/path?x=1", {
      "X-API-Key": "secret",
    });
    expect(out.upstreamUrl).toBe("wss://provider.example.com/path?x=1");
    expect(out.upstreamHeaders).toEqual({ "X-API-Key": "secret" });
  });

  it("derives Authorization: Basic from URL userinfo and strips it", () => {
    const out = resolveProviderOutbound("wss://alice:secret@host.example/");
    expect(out.upstreamUrl).toBe("wss://host.example/");
    expect(out.upstreamHeaders["Authorization"]).toBe(
      `Basic ${globalThis.btoa("alice:secret")}`,
    );
  });

  it("URL-decodes userinfo before base64 encoding", () => {
    const out = resolveProviderOutbound("wss://alice%40acme:p%40ss@host.example/");
    expect(out.upstreamHeaders["Authorization"]).toBe(
      `Basic ${globalThis.btoa("alice@acme:p@ss")}`,
    );
  });

  it("provider-config Authorization wins over URL userinfo", () => {
    const out = resolveProviderOutbound("wss://alice:secret@host/", {
      Authorization: "Bearer token-from-config",
    });
    expect(out.upstreamHeaders["Authorization"]).toBe("Bearer token-from-config");
    expect(out.upstreamUrl).toBe("wss://host/");
  });

  it("case-insensitive Authorization check — lowercase provider header still wins", () => {
    const out = resolveProviderOutbound("wss://alice:secret@host/", {
      authorization: "Bearer lower",
    });
    expect(out.upstreamHeaders["authorization"]).toBe("Bearer lower");
    expect(out.upstreamHeaders["Authorization"]).toBeUndefined();
  });

  it("preserves query string when stripping userinfo", () => {
    const out = resolveProviderOutbound("wss://u:p@host/path?token=x&y=2");
    expect(out.upstreamUrl).toBe("wss://host/path?token=x&y=2");
  });

  it("preserves port when stripping userinfo", () => {
    const out = resolveProviderOutbound("wss://u:p@host:9222/devtools/browser/abc");
    expect(out.upstreamUrl).toBe("wss://host:9222/devtools/browser/abc");
  });

  it("no provider headers, no userinfo: empty headers, URL unchanged", () => {
    const out = resolveProviderOutbound("ws://host/");
    expect(out.upstreamHeaders).toEqual({});
    expect(out.upstreamUrl).toBe("ws://host/");
  });

  it("username-only userinfo (no password) still produces Basic", () => {
    const out = resolveProviderOutbound("wss://tokenonly@host/");
    expect(out.upstreamHeaders["Authorization"]).toBe(
      `Basic ${globalThis.btoa("tokenonly:")}`,
    );
    expect(out.upstreamUrl).toBe("wss://host/");
  });

  it("throws on invalid URL", () => {
    expect(() => resolveProviderOutbound("not-a-url")).toThrow();
  });
});
