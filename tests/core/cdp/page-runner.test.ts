import { describe, expect, it, beforeEach } from "vitest";
import type { CdpProtocolClient } from "../../../src/core/cdp/protocol.js";
import {
  AbortError,
  captureElementScreenshot,
  capturePageHTML,
  captureScreenshot,
  evaluateInPage,
  runPageAction,
  scrollThroughPage,
  type PageOptions,
} from "../../../src/core/cdp/page-runner.js";

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

interface CallRecord {
  method: string;
  params: Record<string, unknown>;
  sessionId: string | undefined;
}

class FakeCdp {
  public readonly calls: CallRecord[] = [];
  private readonly handlers = new Map<string, Handler>();
  private readonly eventListeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  /** Fire Page.loadEventFired after this many ms following each Page.navigate. */
  public autoFireLoadAfterMs: number | null = 0;

  setHandler(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  setResponse(method: string, value: unknown): void {
    this.handlers.set(method, () => value);
  }

  async sendOn(method: string, params: Record<string, unknown> = {}, sessionId: string | undefined): Promise<unknown> {
    this.calls.push({ method, params, sessionId });
    if (method === "Page.navigate" && this.autoFireLoadAfterMs !== null) {
      const after = this.autoFireLoadAfterMs;
      setTimeout(() => this.fire("Page.loadEventFired", {}), after);
    }
    const handler = this.handlers.get(method);
    if (!handler) return {};
    return await handler(params);
  }

  on(event: string, handler: (params: Record<string, unknown>) => void): void {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    set.add(handler);
  }

  off(event: string, handler: (params: Record<string, unknown>) => void): void {
    this.eventListeners.get(event)?.delete(handler);
  }

  fire(event: string, params: Record<string, unknown>): void {
    for (const h of this.eventListeners.get(event) ?? []) h(params);
  }
}

// Cast to CdpProtocolClient — shape matches for our purposes (sendOn/on/off).
function asClient(fake: FakeCdp): CdpProtocolClient {
  return fake as unknown as CdpProtocolClient;
}

describe("runPageAction", () => {
  let cdp: FakeCdp;
  const sessionId = "sess-1";
  const baseOpts: PageOptions = { url: "https://example.com" };

  beforeEach(() => {
    cdp = new FakeCdp();
    cdp.setResponse("Page.navigate", { frameId: "frame-1" });
    cdp.setResponse("Runtime.evaluate", {
      result: { type: "string", value: "https://example.com/" },
    });
  });

  it("enables Page + Runtime + Network domains before doing anything", async () => {
    await runPageAction(asClient(cdp), sessionId, baseOpts, async () => "ok");
    const methods = cdp.calls.map((c) => c.method);
    expect(methods.slice(0, 3)).toEqual(["Page.enable", "Runtime.enable", "Network.enable"]);
  });

  it("sets viewport via Emulation.setDeviceMetricsOverride when provided", async () => {
    await runPageAction(
      asClient(cdp),
      sessionId,
      { ...baseOpts, viewport: { width: 1920, height: 1080 } },
      async () => "ok",
    );
    const emu = cdp.calls.find((c) => c.method === "Emulation.setDeviceMetricsOverride");
    expect(emu).toBeDefined();
    expect(emu?.params).toMatchObject({ width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  });

  it("skips viewport override when not provided", async () => {
    await runPageAction(asClient(cdp), sessionId, baseOpts, async () => "ok");
    expect(cdp.calls.some((c) => c.method === "Emulation.setDeviceMetricsOverride")).toBe(false);
  });

  it("sends UA override + extra headers when provided", async () => {
    await runPageAction(
      asClient(cdp),
      sessionId,
      {
        ...baseOpts,
        userAgent: "Mozilla/5.0 (Test)",
        headers: { "X-Custom": "yes" },
      },
      async () => "ok",
    );
    const ua = cdp.calls.find((c) => c.method === "Network.setUserAgentOverride");
    const h = cdp.calls.find((c) => c.method === "Network.setExtraHTTPHeaders");
    expect(ua?.params).toEqual({ userAgent: "Mozilla/5.0 (Test)" });
    expect(h?.params).toEqual({ headers: { "X-Custom": "yes" } });
  });

  it("calls Page.navigate with the requested URL", async () => {
    await runPageAction(asClient(cdp), sessionId, { url: "https://target.example/" }, async () => "ok");
    const nav = cdp.calls.find((c) => c.method === "Page.navigate");
    expect(nav?.params).toMatchObject({ url: "https://target.example/", transitionType: "typed" });
  });

  it("waits for Page.loadEventFired when waitUntil=load", async () => {
    cdp.autoFireLoadAfterMs = 20;
    const t0 = Date.now();
    await runPageAction(asClient(cdp), sessionId, { ...baseOpts, waitUntil: "load" }, async () => "ok");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(20);
  });

  it("skips waitForNavigation when waitUntil=commit", async () => {
    cdp.autoFireLoadAfterMs = null;
    const t0 = Date.now();
    await runPageAction(asClient(cdp), sessionId, { ...baseOpts, waitUntil: "commit" }, async () => "ok");
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("throws Page.navigate errorText when navigation fails", async () => {
    cdp.setResponse("Page.navigate", { errorText: "net::ERR_NAME_NOT_RESOLVED" });
    await expect(
      runPageAction(asClient(cdp), sessionId, baseOpts, async () => "ok"),
    ).rejects.toThrow(/net::ERR_NAME_NOT_RESOLVED/);
  });

  it("tolerates navigation timeout when tolerateGotoTimeout is set", async () => {
    cdp.autoFireLoadAfterMs = null;
    const result = await runPageAction(
      asClient(cdp),
      sessionId,
      { ...baseOpts, waitUntil: "load", timeout: 50 },
      async () => "action-ran",
      { tolerateGotoTimeout: true },
    );
    expect(result.data).toBe("action-ran");
  });

  it("captures statusCode from Network.responseReceived event for main frame", async () => {
    const action: Promise<unknown> = Promise.resolve();
    cdp.setHandler("Page.navigate", async () => {
      // Fire the response event synchronously with the nav
      setTimeout(() => cdp.fire("Network.responseReceived", { frameId: "frame-1", response: { status: 418, url: "https://example.com/" } }), 5);
      setTimeout(() => cdp.fire("Page.loadEventFired", {}), 15);
      return { frameId: "frame-1" };
    });
    cdp.autoFireLoadAfterMs = null;
    const result = await runPageAction(asClient(cdp), sessionId, baseOpts, async () => (await action, "ok"));
    expect(result.statusCode).toBe(418);
  });

  it("returns navigationMs + actionMs timing", async () => {
    cdp.autoFireLoadAfterMs = 10;
    const result = await runPageAction(asClient(cdp), sessionId, baseOpts, async () => {
      await new Promise((r) => setTimeout(r, 15));
      return "ok";
    });
    expect(result.navigationMs).toBeGreaterThanOrEqual(10);
    expect(result.actionMs).toBeGreaterThanOrEqual(15);
  });

  it("returns resolvedUrl from Runtime.evaluate", async () => {
    cdp.setResponse("Runtime.evaluate", {
      result: { type: "string", value: "https://final.example/" },
    });
    const result = await runPageAction(asClient(cdp), sessionId, baseOpts, async () => "ok");
    expect(result.resolvedUrl).toBe("https://final.example/");
  });
});

describe("captureScreenshot", () => {
  it("issues Page.captureScreenshot with default format=png", async () => {
    const cdp = new FakeCdp();
    cdp.setResponse("Page.captureScreenshot", { data: "AAAA" });
    await captureScreenshot(asClient(cdp), "s1", {});
    const call = cdp.calls.find((c) => c.method === "Page.captureScreenshot");
    expect(call?.params).toMatchObject({ format: "png" });
    expect(call?.params).not.toHaveProperty("quality");
    expect(call?.sessionId).toBe("s1");
  });

  it("passes quality when format=jpeg", async () => {
    const cdp = new FakeCdp();
    cdp.setResponse("Page.captureScreenshot", { data: "AAAA" });
    await captureScreenshot(asClient(cdp), "s1", { format: "jpeg", quality: 80 });
    const call = cdp.calls.find((c) => c.method === "Page.captureScreenshot");
    expect(call?.params).toMatchObject({ format: "jpeg", quality: 80 });
  });

  it("passes clip rect with default scale=1", async () => {
    const cdp = new FakeCdp();
    cdp.setResponse("Page.captureScreenshot", { data: "AAAA" });
    await captureScreenshot(asClient(cdp), "s1", { clip: { x: 10, y: 20, width: 100, height: 50 } });
    const call = cdp.calls.find((c) => c.method === "Page.captureScreenshot");
    expect(call?.params).toMatchObject({ clip: { x: 10, y: 20, width: 100, height: 50, scale: 1 } });
  });

  it("passes captureBeyondViewport for full-page screenshots", async () => {
    const cdp = new FakeCdp();
    cdp.setResponse("Page.captureScreenshot", { data: "AAAA" });
    await captureScreenshot(asClient(cdp), "s1", { captureBeyondViewport: true });
    const call = cdp.calls.find((c) => c.method === "Page.captureScreenshot");
    expect(call?.params.captureBeyondViewport).toBe(true);
  });

  it("decodes base64 response into Uint8Array", async () => {
    const cdp = new FakeCdp();
    // "hello" base64 = "aGVsbG8="
    cdp.setResponse("Page.captureScreenshot", { data: "aGVsbG8=" });
    const bytes = await captureScreenshot(asClient(cdp), "s1", {});
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(5);
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });
});

describe("capturePageHTML", () => {
  it("evaluates document.documentElement.outerHTML", async () => {
    const cdp = new FakeCdp();
    cdp.setResponse("Runtime.evaluate", {
      result: { type: "string", value: "<html><body>hi</body></html>" },
    });
    const html = await capturePageHTML(asClient(cdp), "s1");
    expect(html).toBe("<html><body>hi</body></html>");
    const call = cdp.calls.find((c) => c.method === "Runtime.evaluate");
    expect(call?.params.expression).toBe("document.documentElement.outerHTML");
    expect(call?.params.returnByValue).toBe(true);
    expect(call?.params.awaitPromise).toBe(true);
  });
});

describe("evaluateInPage", () => {
  it("returns the .value from Runtime.evaluate", async () => {
    const cdp = new FakeCdp();
    cdp.setResponse("Runtime.evaluate", {
      result: { type: "number", value: 42 },
    });
    const v = await evaluateInPage<number>(asClient(cdp), "s1", "40+2");
    expect(v).toBe(42);
  });

  it("throws when exceptionDetails is present", async () => {
    const cdp = new FakeCdp();
    cdp.setResponse("Runtime.evaluate", {
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "ReferenceError: nope is not defined" },
      },
    });
    await expect(evaluateInPage(asClient(cdp), "s1", "nope")).rejects.toThrow(/ReferenceError: nope is not defined/);
  });

  it("throws when result is missing", async () => {
    const cdp = new FakeCdp();
    cdp.setResponse("Runtime.evaluate", {});
    await expect(evaluateInPage(asClient(cdp), "s1", "1")).rejects.toThrow(/no result/);
  });

  it("defaults awaitPromise:true and returnByValue:true", async () => {
    const cdp = new FakeCdp();
    cdp.setResponse("Runtime.evaluate", { result: { type: "string", value: "x" } });
    await evaluateInPage(asClient(cdp), "s1", "expr");
    const call = cdp.calls.find((c) => c.method === "Runtime.evaluate");
    expect(call?.params.awaitPromise).toBe(true);
    expect(call?.params.returnByValue).toBe(true);
  });

  it("honours awaitPromise:false when explicitly passed", async () => {
    const cdp = new FakeCdp();
    cdp.setResponse("Runtime.evaluate", { result: { type: "string", value: "x" } });
    await evaluateInPage(asClient(cdp), "s1", "expr", { awaitPromise: false });
    const call = cdp.calls.find((c) => c.method === "Runtime.evaluate");
    expect(call?.params.awaitPromise).toBe(false);
  });
});

describe("runPageAction — AbortSignal", () => {
  const baseOpts: PageOptions = { url: "https://example.com" };

  it("throws AbortError before touching CDP when signal is already aborted", async () => {
    const cdp = new FakeCdp();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runPageAction(asClient(cdp), "s1", { ...baseOpts, signal: controller.signal }, async () => "ok"),
    ).rejects.toBeInstanceOf(AbortError);
    // No CDP calls should have been made at all.
    expect(cdp.calls.length).toBe(0);
  });

  it("throws AbortError from waitForNavigation when signal aborts mid-nav", async () => {
    const cdp = new FakeCdp();
    // Never fire loadEventFired — nav waits forever until abort or timeout.
    cdp.autoFireLoadAfterMs = null;
    cdp.setResponse("Page.navigate", { frameId: "frame-1" });
    cdp.setResponse("Runtime.evaluate", { result: { type: "string", value: "https://example.com/" } });

    const controller = new AbortController();
    const promise = runPageAction(
      asClient(cdp),
      "s1",
      { ...baseOpts, waitUntil: "load", timeout: 60_000, signal: controller.signal },
      async () => "ok",
    );
    // Abort during nav wait.
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toBeInstanceOf(AbortError);
  });

  it("throws AbortError from withTimeout when signal aborts during the user action", async () => {
    const cdp = new FakeCdp();
    cdp.autoFireLoadAfterMs = 5;
    cdp.setResponse("Page.navigate", { frameId: "frame-1" });
    cdp.setResponse("Runtime.evaluate", { result: { type: "string", value: "https://example.com/" } });

    const controller = new AbortController();
    const promise = runPageAction(
      asClient(cdp),
      "s1",
      { ...baseOpts, signal: controller.signal },
      // Action never resolves on its own.
      () => new Promise<string>(() => {}),
    );
    setTimeout(() => controller.abort(), 30);
    await expect(promise).rejects.toBeInstanceOf(AbortError);
  });
});

describe("scrollThroughPage", () => {
  it("runs a single Runtime.evaluate with the scroll-loop expression", async () => {
    const cdp = new FakeCdp();
    cdp.setResponse("Runtime.evaluate", { result: { type: "undefined" } });
    await scrollThroughPage(asClient(cdp), "s1");
    const evalCalls = cdp.calls.filter((c) => c.method === "Runtime.evaluate");
    expect(evalCalls.length).toBe(1);
    const expr = String(evalCalls[0]?.params.expression ?? "");
    expect(expr).toContain("scrollBy");
    expect(expr).toContain("scrollHeight");
    expect(expr).toContain("scrollTo(0, 0)");
  });
});

describe("captureElementScreenshot", () => {
  it("captures a screenshot clipped to the element's bounding rect", async () => {
    const cdp = new FakeCdp();
    cdp.setResponse("Runtime.evaluate", {
      result: { type: "object", value: { x: 100, y: 200, width: 300, height: 150 } },
    });
    cdp.setResponse("Page.captureScreenshot", { data: "AAAA" });

    await captureElementScreenshot(asClient(cdp), "s1", ".hero", { format: "png" });

    const shot = cdp.calls.find((c) => c.method === "Page.captureScreenshot");
    expect(shot?.params).toMatchObject({
      format: "png",
      clip: { x: 100, y: 200, width: 300, height: 150, scale: 1 },
    });
  });

  it("throws when the selector doesn't match anything", async () => {
    const cdp = new FakeCdp();
    cdp.setResponse("Runtime.evaluate", { result: { type: "object", subtype: "null", value: null } });
    await expect(
      captureElementScreenshot(asClient(cdp), "s1", "#missing"),
    ).rejects.toThrow(/Selector "#missing" not found/);
    // Must NOT call Page.captureScreenshot when the element is missing.
    expect(cdp.calls.some((c) => c.method === "Page.captureScreenshot")).toBe(false);
  });

  it("safely embeds selectors with quotes", async () => {
    const cdp = new FakeCdp();
    cdp.setResponse("Runtime.evaluate", { result: { type: "object", value: { x: 0, y: 0, width: 10, height: 10 } } });
    cdp.setResponse("Page.captureScreenshot", { data: "AAAA" });
    await captureElementScreenshot(asClient(cdp), "s1", 'div[data-name="foo"]');
    const evalCall = cdp.calls.find((c) => c.method === "Runtime.evaluate");
    // Selector is JSON.stringify'd, so double-quotes inside are escaped.
    expect(String(evalCall?.params.expression ?? "")).toContain('"div[data-name=\\"foo\\"]"');
  });
});
