import { describe, expect, it } from "vitest";
import {
  redactConnectionUrl,
  redactConnectionUrlsInText,
  redactHeaders,
} from "../../src/core/redact.js";

describe("redactConnectionUrl", () => {
  it("masks query credentials whatever they are called", () => {
    for (const param of ["token", "apikey", "api_key", "key", "secret", "password", "jwt"]) {
      const masked = redactConnectionUrl(`wss://provider.example/?${param}=SUPERSECRET`);
      expect(masked).not.toContain("SUPERSECRET");
    }
  });

  it("masks username and password carried in the url itself", () => {
    const masked = redactConnectionUrl("wss://brd-customer-x:PASSWORD@brd.superproxy.io:9222/");
    expect(masked).not.toContain("PASSWORD");
    expect(masked).toContain("***:***@");
  });

  it("leaves routing parameters readable", () => {
    const masked = redactConnectionUrl(
      "wss://browser.example/?apikey=SUPERSECRET&proxy_region=eu&session_ttl=600",
    );
    expect(masked).toContain("proxy_region=eu");
    expect(masked).toContain("session_ttl=600");
    expect(masked).not.toContain("SUPERSECRET");
  });

  it("returns input unchanged when it is not a url", () => {
    expect(redactConnectionUrl("not a url")).toBe("not a url");
  });
});

describe("redactHeaders", () => {
  it("masks credential headers and keeps the rest", () => {
    const masked = redactHeaders({
      Authorization: "Bearer SUPERSECRET",
      "x-api-key": "SUPERSECRET",
      "anchor-api-key": "SUPERSECRET",
      "user-agent": "browser-gateway",
    });
    expect(Object.values(masked)).not.toContain("Bearer SUPERSECRET");
    expect(masked["x-api-key"]).toBe("***");
    expect(masked["anchor-api-key"]).toBe("***");
    expect(masked["user-agent"]).toBe("browser-gateway");
  });

  it("handles no headers", () => {
    expect(redactHeaders(undefined)).toEqual({});
  });
});

describe("redactConnectionUrlsInText", () => {
  it("masks secrets inside a config blob", () => {
    const yaml = [
      "providers:",
      "  a:",
      "    url: wss://provider.example/?token=SUPERSECRET&region=eu",
      "  b:",
      "    url: wss://user:PASSWORD@proxy.example:9222/",
    ].join("\n");
    const masked = redactConnectionUrlsInText(yaml);
    expect(masked).not.toContain("SUPERSECRET");
    expect(masked).not.toContain("PASSWORD");
    expect(masked).toContain("region=eu");
  });
});
