import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureState } from "../../src/core/profile/capture.js";
import { injectState } from "../../src/core/profile/inject.js";
import { findChromePath, launchChrome, type LaunchedChrome } from "./profile-fixtures/chrome.js";
import { startTestServer, type TestServer } from "./profile-fixtures/test-server.js";

const HAS_CHROME = findChromePath() !== null;
const describeIfChrome = HAS_CHROME ? describe : describe.skip;

describeIfChrome("integration: capture + inject end-to-end", () => {
  let server: TestServer;
  let source: LaunchedChrome;
  let target: LaunchedChrome;

  beforeAll(async () => {
    server = await startTestServer();
    source = await launchChrome();
    target = await launchChrome();
  }, 60_000);

  afterAll(async () => {
    await source?.close();
    await target?.close();
    await server?.close();
  });

  it("transfers session cookie and localStorage from source to target", async () => {
    // 1. Source: log in as 'alice'
    await source.page.goto(`${server.url}/login?u=alice`, { waitUntil: "load" });
    const sourceWho = await source.page.evaluate(async (url: string) => {
      const r = await fetch(`${url}/whoami`);
      return r.json();
    }, server.url);
    expect(sourceWho).toEqual({ session: "alice" });

    const sourceLocal = await source.page.evaluate(() => ({
      token: localStorage.getItem("token"),
      display: localStorage.getItem("display"),
    }));
    expect(sourceLocal).toEqual({ token: "tok-alice", display: "alice" });

    // 2. Capture state via CDP
    const captured = await captureState(source.cdp, { origins: [server.url] });

    expect(captured.cookies.length).toBeGreaterThanOrEqual(2);
    expect(captured.cookies.find((c) => c.name === "session")).toMatchObject({
      name: "session",
      value: "alice",
      httpOnly: true,
    });
    expect(captured.cookies.find((c) => c.name === "display")?.value).toBe("alice");
    expect(captured.storage[server.url]?.localStorage).toEqual({
      token: "tok-alice",
      display: "alice",
    });
    expect(captured.meta.capturedOrigins).toEqual([server.url]);
    expect(captured.meta.skippedOrigins).toEqual([]);

    // 3. Inject into a fresh target browser
    const result = await injectState(target.cdp, captured);
    expect(result.cookiesSet).toBe(captured.cookies.length);
    expect(result.originsInjected).toEqual([server.url]);
    expect(result.skippedOrigins).toEqual([]);

    // 4. Target should now see itself logged in as alice
    await target.page.goto(server.url, { waitUntil: "load" });
    const targetWho = await target.page.evaluate(async (url: string) => {
      const r = await fetch(`${url}/whoami`);
      return r.json();
    }, server.url);
    expect(targetWho).toEqual({ session: "alice" });

    const targetLocal = await target.page.evaluate(() => ({
      token: localStorage.getItem("token"),
      display: localStorage.getItem("display"),
    }));
    expect(targetLocal).toEqual({ token: "tok-alice", display: "alice" });
  }, 60_000);

  it("captures from empty browser returns version=1, no cookies, no storage", async () => {
    const fresh = await launchChrome();
    try {
      const captured = await captureState(fresh.cdp, { origins: [server.url] });
      expect(captured.version).toBe(1);
      expect(captured.cookies).toEqual([]);
      expect(captured.storage[server.url]).toMatchObject({ localStorage: {}, sessionStorage: {} });
      expect(captured.storage[server.url].lastVisitedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await fresh.close();
    }
  }, 60_000);

  it("inject into fresh browser with no storage but cookies works", async () => {
    const fresh = await launchChrome();
    try {
      const result = await injectState(fresh.cdp, {
        version: 1,
        capturedAt: new Date().toISOString(),
        cookies: [
          { name: "anonymous", value: "yes", domain: "127.0.0.1", path: "/", secure: false, httpOnly: false, sameSite: "Lax" },
        ],
        storage: {},
        meta: { userAgent: undefined, capturedOrigins: [], skippedOrigins: [], durationMs: 0 },
      });
      expect(result.cookiesSet).toBe(1);
      expect(result.originsInjected).toEqual([]);

      await fresh.page.goto(server.url, { waitUntil: "load" });
      const who = await fresh.page.evaluate(async (url: string) => {
        const r = await fetch(`${url}/whoami`);
        return r.json();
      }, server.url);
      expect(who).toEqual({ session: null });
    } finally {
      await fresh.close();
    }
  }, 60_000);

  it("skip-on-error: bogus origin doesn't poison the rest of the capture", async () => {
    await source.page.goto(`${server.url}/login?u=bob`, { waitUntil: "load" });
    const captured = await captureState(source.cdp, {
      origins: [
        "http://this-host-does-not-exist.invalid",
        server.url,
      ],
      navigationTimeoutMs: 4_000,
    });
    expect(captured.meta.capturedOrigins).toEqual([server.url]);
    expect(captured.meta.skippedOrigins[0]?.origin).toBe("http://this-host-does-not-exist.invalid");
  }, 60_000);
});
