import { describe, expect, it, afterEach } from "vitest";
import type { IncomingMessage } from "node:http";
import { isHostAllowed, isOriginAllowed, parseAllowedHosts } from "../../src/server/util/origin.js";

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

afterEach(() => {
  delete process.env.BG_TRUST_PROXY;
});

describe("isHostAllowed ignores X-Forwarded-Host by default", () => {
  const none = parseAllowedHosts(undefined);

  it("rejects a foreign Host", () => {
    expect(isHostAllowed(req({ host: "evil.attacker.com" }), none)).toBe(false);
  });

  it("rejects a foreign Host even when X-Forwarded-Host claims loopback", () => {
    expect(
      isHostAllowed(req({ host: "evil.attacker.com", "x-forwarded-host": "localhost" }), none),
    ).toBe(false);
  });

  it("rejects a foreign Host even when X-Forwarded-Host names an allowlisted name", () => {
    const allowed = parseAllowedHosts("gateway.internal");
    expect(
      isHostAllowed(req({ host: "evil.attacker.com", "x-forwarded-host": "gateway.internal" }), allowed),
    ).toBe(false);
  });

  it("still accepts a genuine loopback Host", () => {
    expect(isHostAllowed(req({ host: "localhost:9500" }), none)).toBe(true);
    expect(isHostAllowed(req({ host: "127.0.0.1:9500" }), none)).toBe(true);
  });

  it("still accepts an allowlisted Host, port stripped", () => {
    const allowed = parseAllowedHosts("gateway.internal");
    expect(isHostAllowed(req({ host: "gateway.internal:9500" }), allowed)).toBe(true);
  });

  it("rejects a request with no Host at all", () => {
    expect(isHostAllowed(req({}), none)).toBe(false);
  });
});

describe("isHostAllowed honours X-Forwarded-Host only behind a trusted proxy", () => {
  it("uses the forwarded host when BG_TRUST_PROXY=1", () => {
    process.env.BG_TRUST_PROXY = "1";
    const allowed = parseAllowedHosts("gateway.internal");
    expect(
      isHostAllowed(req({ host: "10.0.0.5:9500", "x-forwarded-host": "gateway.internal" }), allowed),
    ).toBe(true);
  });

  it("does not treat any other value as enabling trust", () => {
    process.env.BG_TRUST_PROXY = "true";
    expect(
      isHostAllowed(req({ host: "evil.attacker.com", "x-forwarded-host": "localhost" }), parseAllowedHosts(undefined)),
    ).toBe(false);
  });
});

describe("isOriginAllowed uses the same host source", () => {
  it("does not let X-Forwarded-Host make a foreign Origin look same-origin", () => {
    expect(
      isOriginAllowed(
        req({ origin: "http://evil.attacker.com", host: "localhost:9500", "x-forwarded-host": "evil.attacker.com" }),
        new Set(),
      ),
    ).toBe(false);
  });

  it("still allows a genuine same-origin request", () => {
    expect(isOriginAllowed(req({ origin: "http://localhost:9500", host: "localhost:9500" }), new Set())).toBe(true);
  });

  it("still allows a non-browser client that sends no Origin", () => {
    expect(isOriginAllowed(req({ host: "localhost:9500" }), new Set())).toBe(true);
  });
});
