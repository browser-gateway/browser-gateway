import { beforeEach, describe, expect, it } from "vitest";
import { injectState } from "../../../src/core/profile/inject.js";
import type { CapturedProfile } from "../../../src/core/profile/types.js";
import { MockCDP } from "./mock-cdp.js";

let cdp: MockCDP;

beforeEach(() => {
  cdp = new MockCDP();
});

function emptyProfile(overrides: Partial<CapturedProfile> = {}): CapturedProfile {
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    cookies: [],
    storage: {},
    meta: {
      userAgent: undefined,
      capturedOrigins: [],
      skippedOrigins: [],
      durationMs: 0,
    },
    ...overrides,
  };
}

describe("injectState — happy path", () => {
  it("does nothing when profile is empty", async () => {
    const result = await injectState(cdp, emptyProfile());
    expect(result.cookiesSet).toBe(0);
    expect(result.originsInjected).toEqual([]);
    expect(result.skippedOrigins).toEqual([]);
    expect(cdp.callsForMethod("Network.setCookies")).toHaveLength(0);
    expect(cdp.callsForMethod("Page.navigate")).toHaveLength(0);
  });

  it("calls Network.setCookies with the captured cookies", async () => {
    const profile = emptyProfile({
      cookies: [
        { name: "session", value: "abc", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
        { name: "csrf", value: "xyz", domain: ".example.com", path: "/", secure: false, httpOnly: false, expires: 0 },
      ],
    });
    const result = await injectState(cdp, profile);
    expect(result.cookiesSet).toBe(2);
    const calls = cdp.callsForMethod("Network.setCookies");
    expect(calls).toHaveLength(1);
    const cookies = (calls[0]!.params.cookies as unknown[]) ?? [];
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatchObject({
      name: "session",
      value: "abc",
      domain: ".example.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
    // expires=0 is treated as session cookie — not forwarded
    expect((cookies[1] as Record<string, unknown>).expires).toBeUndefined();
  });

  it("navigates per origin and writes storage", async () => {
    cdp.setHandler("Runtime.evaluate", () => ({
      result: { type: "object", value: { localStorageWrote: 2, sessionStorageWrote: 1, errors: [] } },
    }));
    const profile = emptyProfile({
      storage: {
        "https://example.com": {
          localStorage: { a: "1", b: "2" },
          sessionStorage: { c: "3" },
        },
      },
    });
    const result = await injectState(cdp, profile);
    expect(result.originsInjected).toEqual(["https://example.com"]);
    const navCalls = cdp.callsForMethod("Page.navigate");
    expect(navCalls).toHaveLength(1);
    expect(navCalls[0]!.params.url).toBe("https://example.com");
  });

  it("skips origins whose storage is empty (no navigation)", async () => {
    const profile = emptyProfile({
      storage: {
        "https://empty.com": { localStorage: {}, sessionStorage: {} },
      },
    });
    const result = await injectState(cdp, profile);
    expect(result.originsInjected).toEqual([]);
    expect(cdp.callsForMethod("Page.navigate")).toHaveLength(0);
  });
});

describe("injectState — per-origin failure isolation", () => {
  it("navigation error → origin skipped, others still injected", async () => {
    let i = 0;
    cdp.setHandler("Page.navigate", () => {
      i++;
      if (i === 1) return { errorText: "net::ERR_TIMED_OUT" };
      return {};
    });
    cdp.setHandler("Runtime.evaluate", () => ({
      result: { type: "object", value: { localStorageWrote: 1, sessionStorageWrote: 0, errors: [] } },
    }));
    const profile = emptyProfile({
      storage: {
        "https://broken.com": { localStorage: { a: "1" }, sessionStorage: {} },
        "https://works.com": { localStorage: { b: "2" }, sessionStorage: {} },
      },
    });
    const result = await injectState(cdp, profile);
    expect(result.originsInjected).toEqual(["https://works.com"]);
    expect(result.skippedOrigins[0]?.origin).toBe("https://broken.com");
    expect(result.skippedOrigins[0]?.reason).toMatch(/ERR_TIMED_OUT/);
  });

  it("Runtime.evaluate exception → origin skipped", async () => {
    cdp.setHandler("Runtime.evaluate", () => ({
      result: { type: "undefined" },
      exceptionDetails: { exception: { description: "SecurityError" } },
    }));
    const profile = emptyProfile({
      storage: {
        "https://denied.com": { localStorage: { x: "1" }, sessionStorage: {} },
      },
    });
    const result = await injectState(cdp, profile);
    expect(result.originsInjected).toEqual([]);
    expect(result.skippedOrigins[0]?.reason).toMatch(/SecurityError/);
  });

  it("evaluate returns nothing meaningful → origin skipped", async () => {
    cdp.setHandler("Runtime.evaluate", () => ({ result: { type: "undefined" } }));
    const profile = emptyProfile({
      storage: { "https://x.com": { localStorage: { k: "v" }, sessionStorage: {} } },
    });
    const result = await injectState(cdp, profile);
    expect(result.skippedOrigins[0]?.reason).toMatch(/no result/);
  });
});

describe("injectState — cancellation", () => {
  it("respects pre-aborted signal", async () => {
    const c = new AbortController();
    c.abort();
    const profile = emptyProfile({ cookies: [{ name: "a", value: "b", domain: "x", path: "/", secure: false, httpOnly: false }] });
    await expect(injectState(cdp, profile, { signal: c.signal })).rejects.toThrow(/aborted/);
    expect(cdp.calls).toHaveLength(0);
  });
});
