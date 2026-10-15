import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CdpProtocolClient } from "../../src/core/cdp/protocol.js";
import { inputCounterExpression, probePointExpression } from "../../src/pipeline/plugins/login-detector.js";
import { chromePath, NodeWsTransport, startRealChrome, type RealChrome } from "../helpers/real-chrome.js";

const FRAME_UNDER_POINTER = `<!doctype html><html><body style="margin:0">
<iframe srcdoc="<p>widget</p>" style="position:absolute;left:100px;top:100px;width:300px;height:80px;border:0"></iframe></body></html>`;
const FRAME_EVERYWHERE = `<!doctype html><html><body style="margin:0">
<iframe srcdoc="<p>widget</p>" style="position:fixed;inset:0;width:100vw;height:100vh;border:0"></iframe></body></html>`;

describe.skipIf(!chromePath)("live view input probe against a real Chrome", () => {
  let chrome: RealChrome;
  let cdp: CdpProtocolClient;
  let sessionId: string;

  beforeAll(async () => {
    chrome = await startRealChrome({ "/under": FRAME_UNDER_POINTER, "/everywhere": FRAME_EVERYWHERE });
    const wire = new NodeWsTransport(chrome.browserWsUrl);
    await wire.ready();
    cdp = new CdpProtocolClient(wire);
    const { targetId } = (await cdp.sendOn("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    ({ sessionId } = (await cdp.sendOn("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string });
    await cdp.sendOn("Page.enable", {}, sessionId);
  }, 60_000);

  afterAll(async () => {
    await cdp?.close().catch(() => undefined);
    await chrome?.stop();
  });

  async function load(path: string): Promise<void> {
    const loaded = new Promise<void>((resolve) => cdp.on("Page.loadEventFired", () => resolve()));
    await cdp.sendOn("Page.navigate", { url: `${chrome.baseUrl}${path}` }, sessionId);
    await loaded;
  }

  async function evaluate<T>(expression: string): Promise<T> {
    const r = (await cdp.sendOn("Runtime.evaluate", { expression, returnByValue: true }, sessionId)) as { result: { value: T } };
    return r.result.value;
  }

  async function pageSeesMove(x: number, y: number): Promise<boolean> {
    const counter = inputCounterExpression("__probeTest");
    const before = await evaluate<number>(counter);
    await cdp.sendOn("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0, modifiers: 0 }, sessionId);
    await cdp.sendOn("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 1, y, button: "none", buttons: 0, modifiers: 0 }, sessionId);
    return (await evaluate<number>(counter)) > before;
  }

  it("moves the check off an embedded frame to a spot the page itself receives", async () => {
    await load("/under");
    expect(await pageSeesMove(200, 130)).toBe(false);
    const point = await evaluate<{ x: number; y: number } | null>(probePointExpression(200, 130));
    expect(point).not.toBeNull();
    expect(point).not.toEqual({ x: 200, y: 130 });
    expect(await pageSeesMove(point!.x, point!.y)).toBe(true);
  });

  it("keeps the pointer spot when nothing covers it", async () => {
    await load("/under");
    expect(await evaluate(probePointExpression(600, 400))).toEqual({ x: 600, y: 400 });
  });

  it("reports no spot when an embedded frame covers the whole page", async () => {
    await load("/everywhere");
    expect(await evaluate(probePointExpression(200, 130))).toBeNull();
  });
});
