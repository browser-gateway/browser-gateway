import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromePath, startRealChrome, type RealChrome } from "../helpers/real-chrome.js";
import { applyOpenOptions, fetchPage, runAgentTool } from "../../src/agent-tools/index.js";

const PAGE = (n: number) =>
  `<!doctype html><html><head><title>Page ${n}</title></head><body><h1>Page ${n}</h1>${"<p>row</p>".repeat(n)}<button>Go</button></body></html>`;
const COUNT_ROWS = "document.querySelectorAll('p').length";

describe.skipIf(!chromePath)("agent tool options against a real Chrome", () => {
  let chrome: RealChrome;

  beforeAll(async () => {
    chrome = await startRealChrome({
      "/one": PAGE(1),
      "/three": PAGE(3),
      "/config": { body: '{"ok":true,"panels":2}', headers: { "content-type": "application/json" }, status: 200 },
      "/plain": { body: "ok", headers: { "content-type": "text/plain" }, status: 200 },
    });
  }, 60_000);

  afterAll(async () => {
    await chrome.stop();
  });

  it("saves a script once and runs it by name on later pages, with or without the element list", async () => {
    const { session, dispose } = await chrome.connect();
    try {
      const first = (await runAgentTool(session, "browser_navigate", {
        url: `${chrome.baseUrl}/one`,
        evaluate: COUNT_ROWS,
        saveAs: "rows",
        snapshot: false,
      })) as Record<string, unknown>;
      expect(first).toMatchObject({ title: "Page 1", value: 1 });
      expect(first).not.toHaveProperty("snapshot");

      const second = (await runAgentTool(session, "browser_navigate", { url: `${chrome.baseUrl}/three`, script: "rows" })) as Record<string, unknown>;
      expect(second["value"]).toBe(3);
      expect(String(second["snapshot"])).toContain("Go");

      expect(await runAgentTool(session, "browser_evaluate", { script: "rows" })).toEqual({ value: 3 });
      await expect(runAgentTool(session, "browser_evaluate", { script: "missing" })).rejects.toThrow(/no saved script named "missing".*Saved: rows/);
      await expect(runAgentTool(session, "browser_evaluate", {})).rejects.toThrow(/needs an expression/);
    } finally {
      await dispose();
    }
  });

  it("sets the window size an agent asks for when opening and reports what the page got", async () => {
    const { session, dispose } = await chrome.connect();
    try {
      await session.navigate(`${chrome.baseUrl}/one`);
      const { window } = await applyOpenOptions(session, { width: 1280, height: 800 });
      expect(window).toEqual({ requested: { width: 1280, height: 800 }, applied: { width: 1280, height: 800 }, matched: true });
      expect(await applyOpenOptions(session, {})).toEqual({});
      await expect(applyOpenOptions(session, { width: 1280 })).rejects.toThrow(/both width and height/);
    } finally {
      await dispose();
    }
  });

  it("returns screenshots as lossless PNG when asked, JPEG otherwise", async () => {
    const { session, dispose } = await chrome.connect();
    try {
      await session.navigate(`${chrome.baseUrl}/one`);
      const png = (await runAgentTool(session, "browser_screenshot", { format: "png" })) as { format: string; base64: string };
      expect(png.format).toBe("png");
      expect(png.base64.startsWith("iVBORw0KGgo")).toBe(true);
      expect(((await runAgentTool(session, "browser_screenshot", {})) as { format: string }).format).toBe("jpeg");
    } finally {
      await dispose();
    }
  });

  it("returns JSON and plain text bodies as they are, never flagged as blocked", async () => {
    const { session, dispose } = await chrome.connect();
    try {
      const json = await fetchPage(session, { url: `${chrome.baseUrl}/config` });
      expect(json).toMatchObject({ format: "text", contentType: "application/json", text: '{"ok":true,"panels":2}' });
      expect(json.blocked).toBeUndefined();
      const plain = await fetchPage(session, { url: `${chrome.baseUrl}/plain` });
      expect(plain).toMatchObject({ text: "ok", contentType: "text/plain" });
      expect(plain.blocked).toBeUndefined();
      const page = await fetchPage(session, { url: `${chrome.baseUrl}/three` });
      expect(page.contentType).toBeUndefined();
    } finally {
      await dispose();
    }
  });
});
