import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { isHostAllowed, isOriginAllowed, parseAllowedHosts } from "../../src/server/util/origin.js";

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("isOriginAllowed", () => {
  it("allows a request with no Origin (non-browser client)", () => {
    expect(isOriginAllowed(req({ host: "localhost:9500" }), new Set())).toBe(true);
  });

  it("allows a same-origin browser request", () => {
    expect(isOriginAllowed(req({ host: "localhost:9500", origin: "http://localhost:9500" }), new Set())).toBe(true);
  });

  it("rejects a foreign origin", () => {
    expect(isOriginAllowed(req({ host: "localhost:9500", origin: "https://evil.example" }), new Set())).toBe(false);
  });

  it("allows an allowlisted origin", () => {
    const allowed = new Set(["https://dash.example"]);
    expect(isOriginAllowed(req({ host: "localhost:9500", origin: "https://dash.example" }), allowed)).toBe(true);
  });
});

describe("isHostAllowed", () => {
  it("allows loopback hosts", () => {
    for (const host of ["localhost:9500", "127.0.0.1:9500", "[::1]:9500"]) {
      expect(isHostAllowed(req({ host }), new Set()), host).toBe(true);
    }
  });

  it("rejects a rebound attacker hostname", () => {
    expect(isHostAllowed(req({ host: "evil.attacker.com:9500" }), new Set())).toBe(false);
  });

  it("allows a host named in BG_ALLOWED_HOSTS", () => {
    expect(isHostAllowed(req({ host: "gw.example:9500" }), parseAllowedHosts("gw.example"))).toBe(true);
  });

  it("rejects a request with no Host", () => {
    expect(isHostAllowed(req({}), new Set())).toBe(false);
  });
});
