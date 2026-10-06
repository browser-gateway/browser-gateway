import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromePath, startRealChrome, type RealChrome } from "../helpers/real-chrome.js";
import { ComputerUseSession } from "../../src/agent-tools/computer-use/index.js";

const HOME_HTML = `<!doctype html><html><head><title>Home</title></head><body style="margin:0">
<div id="target" style="position:absolute;left:600px;top:400px;width:40px;height:40px;background:#000"></div>
<script>window.hits=[];addEventListener("mousedown",(e)=>hits.push([e.clientX,e.clientY]));</script></body></html>`;

describe.skipIf(!chromePath)("computer-use session against a real Chrome", () => {
  let chrome: RealChrome;
  const open = { urls: { blockPrivateNetworks: false } };

  beforeAll(async () => {
    chrome = await startRealChrome({ "/home": HOME_HTML, "/away": { body: "", headers: { location: "http://localhost/elsewhere" }, status: 302 } });
  }, 60_000);

  afterAll(async () => {
    await chrome.stop();
  });

  it("connects with the runtime's own WebSocket and shows a page at the default frame size", async () => {
    const session = await ComputerUseSession.open("anthropic-browser", {
      endpoint: chrome.browserWsUrl,
      startUrl: `${chrome.baseUrl}/home`,
      ...open,
    });
    try {
      const seen = await session.observe();
      expect(seen).toMatchObject({ mimeType: "image/png", width: 1440, height: 900, url: `${chrome.baseUrl}/home` });
      await session.agent.clickAt(session.toPage({ x: 610, y: 410 }));
      expect(await session.agent.evaluate<number[][]>("window.hits")).toEqual([[610, 410]]);
    } finally {
      await session.close();
    }
  });

  it("zooms a region to fill the frame", async () => {
    const session = await ComputerUseSession.open("anthropic-browser", { endpoint: chrome.browserWsUrl, startUrl: `${chrome.baseUrl}/home`, ...open });
    try {
      const zoomed = await session.zoom({ x0: 0, y0: 0, x1: 720, y1: 450 });
      expect(zoomed).toMatchObject({ width: 1440, height: 900 });
    } finally {
      await session.close();
    }
  });

  it("refuses unsafe addresses and pages that redirect outside the allowed sites", async () => {
    const session = await ComputerUseSession.open("gemini", { endpoint: chrome.browserWsUrl, urls: { allowedHosts: ["127.0.0.1"], blockPrivateNetworks: false } });
    try {
      await expect(session.navigate("javascript:alert(1)")).rejects.toThrow(/only http and https/);
      await expect(session.navigate(`${chrome.baseUrl}/away`)).rejects.toThrow(/redirected somewhere this session may not open/);
      expect((await session.agent.tabInventory())[0]?.url).toBe("about:blank");
    } finally {
      await session.close();
    }
  });

  it("blocks private network addresses by default", async () => {
    const session = await ComputerUseSession.open("gemini", { endpoint: chrome.browserWsUrl });
    try {
      await expect(session.navigate(`${chrome.baseUrl}/home`)).rejects.toThrow(/private network/);
    } finally {
      await session.close();
    }
  });

  it("never shows the endpoint in a connection error", async () => {
    const endpoint = "ws://127.0.0.1:1/v1/connect?token=bg_secret_value";
    const failed = await ComputerUseSession.open("gemini", { endpoint }).catch((err: Error) => err);
    expect(failed).toBeInstanceOf(Error);
    expect(String((failed as Error).message)).not.toContain("bg_secret_value");
  });
});
