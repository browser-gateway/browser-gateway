import { describe, expect, it, beforeEach } from "vitest";
import { captureState } from "../../../src/core/profile/capture.js";
import { MockCDP } from "./mock-cdp.js";

let cdp: MockCDP;

beforeEach(() => {
  cdp = new MockCDP();
});

describe("captureState — happy path", () => {
  it("returns version 1 + capturedAt with no origins", async () => {
    cdp.setResponse("Network.getAllCookies", { cookies: [] });
    const profile = await captureState(cdp);
    expect(profile.version).toBe(1);
    expect(typeof profile.capturedAt).toBe("string");
    expect(profile.cookies).toEqual([]);
    expect(profile.storage).toEqual({});
    expect(profile.meta.capturedOrigins).toEqual([]);
    expect(profile.meta.skippedOrigins).toEqual([]);
  });

  it("captures cookies", async () => {
    cdp.setResponse("Network.getAllCookies", {
      cookies: [
        { name: "session", value: "abc", domain: ".example.com", path: "/", secure: true, httpOnly: true },
      ],
    });
    const profile = await captureState(cdp);
    expect(profile.cookies).toHaveLength(1);
    expect(profile.cookies[0]).toMatchObject({ name: "session", value: "abc" });
  });

  it("captures localStorage and sessionStorage from an origin", async () => {
    cdp.setResponse("Network.getAllCookies", { cookies: [] });
    cdp.setHandler("Runtime.evaluate", (p) => {
      const expr = String(p.expression);
      if (expr.includes("localStorage") && expr.includes("sessionStorage")) {
        return {
          result: {
            type: "string",
            value: JSON.stringify({
              localStorage: { token: "xyz", user: "alice" },
              sessionStorage: { csrf: "qwerty" },
            }),
          },
        };
      }
      if (expr.includes("navigator.userAgent")) {
        return { result: { type: "string", value: "TestUA/1.0" } };
      }
      return { result: { type: "undefined" } };
    });

    const profile = await captureState(cdp, { origins: ["https://example.com"] });

    expect(profile.storage["https://example.com"]).toEqual({
      localStorage: { token: "xyz", user: "alice" },
      sessionStorage: { csrf: "qwerty" },
    });
    expect(profile.meta.capturedOrigins).toEqual(["https://example.com"]);
    expect(profile.meta.userAgent).toBe("TestUA/1.0");
  });

  it("normalises and deduplicates origins (trailing slash, path, duplicates)", async () => {
    cdp.setResponse("Network.getAllCookies", { cookies: [] });
    let count = 0;
    cdp.setHandler("Runtime.evaluate", () => {
      count++;
      return {
        result: { type: "string", value: JSON.stringify({ localStorage: {}, sessionStorage: {} }) },
      };
    });
    const profile = await captureState(cdp, {
      origins: [
        "https://example.com/",
        "https://example.com/login",
        "https://example.com",
      ],
    });
    expect(profile.meta.capturedOrigins).toEqual(["https://example.com"]);
    // 1 storage eval + 1 UA eval
    expect(count).toBe(2);
  });

  it("rejects invalid origins (non-http schemes)", async () => {
    cdp.setResponse("Network.getAllCookies", { cookies: [] });
    const profile = await captureState(cdp, {
      origins: ["file:///etc/passwd", "javascript:alert(1)", "ftp://x.com", "not-a-url"],
    });
    expect(profile.meta.capturedOrigins).toEqual([]);
    expect(profile.storage).toEqual({});
  });
});

describe("captureState — per-origin failure isolation", () => {
  it("skip-on-error: one origin fails, the rest succeed", async () => {
    cdp.setResponse("Network.getAllCookies", { cookies: [] });
    let originSeen = 0;
    cdp.setHandler("Page.navigate", () => {
      originSeen++;
      if (originSeen === 1) return { errorText: "net::ERR_NAME_NOT_RESOLVED" };
      return {};
    });
    cdp.setHandler("Runtime.evaluate", (p) => {
      const expr = String(p.expression);
      if (expr.includes("localStorage")) {
        return { result: { type: "string", value: JSON.stringify({ localStorage: { k: "v" }, sessionStorage: {} }) } };
      }
      return { result: { type: "string", value: "UA" } };
    });

    const profile = await captureState(cdp, {
      origins: ["https://broken.com", "https://works.com"],
    });
    expect(profile.meta.capturedOrigins).toEqual(["https://works.com"]);
    expect(profile.meta.skippedOrigins[0]?.origin).toBe("https://broken.com");
    expect(profile.meta.skippedOrigins[0]?.reason).toMatch(/ERR_NAME_NOT_RESOLVED/);
  });

  it("skip-on-error: Runtime.evaluate throws an exception", async () => {
    cdp.setResponse("Network.getAllCookies", { cookies: [] });
    cdp.setHandler("Runtime.evaluate", (p) => {
      const expr = String(p.expression);
      if (expr.includes("localStorage")) {
        return {
          result: { type: "undefined" },
          exceptionDetails: { exception: { description: "SecurityError: localStorage denied" } },
        };
      }
      return { result: { type: "string", value: "UA" } };
    });
    const profile = await captureState(cdp, { origins: ["https://example.com"] });
    expect(profile.meta.capturedOrigins).toEqual([]);
    expect(profile.meta.skippedOrigins[0]?.reason).toMatch(/SecurityError/);
  });

  it("skip-on-error: page-context storage read fails (__error bag)", async () => {
    cdp.setResponse("Network.getAllCookies", { cookies: [] });
    cdp.setHandler("Runtime.evaluate", (p) => {
      const expr = String(p.expression);
      if (expr.includes("localStorage")) {
        return {
          result: {
            type: "string",
            value: JSON.stringify({ localStorage: { __error: "QuotaExceeded" }, sessionStorage: {} }),
          },
        };
      }
      return { result: { type: "string", value: "UA" } };
    });
    const profile = await captureState(cdp, { origins: ["https://example.com"] });
    expect(profile.meta.capturedOrigins).toEqual([]);
    expect(profile.meta.skippedOrigins[0]?.reason).toMatch(/storage read error/);
  });
});

describe("captureState — cancellation and timeouts", () => {
  it("respects AbortSignal — pre-aborted", async () => {
    const c = new AbortController();
    c.abort();
    await expect(captureState(cdp, { signal: c.signal })).rejects.toThrow(/aborted/);
    expect(cdp.calls).toHaveLength(0);
  });

  it("evaluate timeout fires and is reported as a skipped origin", async () => {
    cdp.setResponse("Network.getAllCookies", { cookies: [] });
    // Make Runtime.evaluate hang.
    cdp.setHandler("Runtime.evaluate", () => new Promise(() => undefined));

    const profile = await captureState(cdp, {
      origins: ["https://slow.com"],
      navigationTimeoutMs: 50,
      evaluateTimeoutMs: 50,
    });
    expect(profile.meta.capturedOrigins).toEqual([]);
    expect(profile.meta.skippedOrigins[0]?.reason).toMatch(/timeout/);
  });

  it("navigation timeout: Page.navigate hangs → origin skipped", async () => {
    cdp.setResponse("Network.getAllCookies", { cookies: [] });
    cdp.autoFireLoadAfterMs = null; // don't auto-emit
    cdp.setHandler("Page.navigate", () => new Promise(() => undefined));
    const profile = await captureState(cdp, {
      origins: ["https://slow.com"],
      navigationTimeoutMs: 50,
    });
    expect(profile.meta.capturedOrigins).toEqual([]);
    expect(profile.meta.skippedOrigins[0]?.reason).toMatch(/timeout/);
  });
});
