import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromePath, startRealChrome, type RealChrome } from "../helpers/real-chrome.js";
import type { AgentSession } from "../../src/agent-tools/index.js";

const BANDS_HTML = `<!doctype html><html><head><title>Bands</title>
<style>body{margin:0}.band{height:900px}</style></head><body>
<div class="band" style="background:rgb(255,0,0)"></div><div class="band" style="background:rgb(0,255,0)"></div>
<script>window.clicks=[];addEventListener("mousedown",(e)=>clicks.push([e.clientX,e.clientY]));</script>
</body></html>`;

/** Colour of one pixel of a base64 PNG, read by drawing it in the page. */
async function pixel(session: AgentSession, base64: string, x: number, y: number): Promise<number[]> {
  return (await session.evaluate<number[]>(`new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      resolve(Array.from(g.getImageData(${x}, ${y}, 1, 1).data.slice(0, 3)));
    };
    img.src = "data:image/png;base64,${base64}";
  })`))!;
}

describe.skipIf(!chromePath)("frame-sized screenshots against a real Chrome", () => {
  let chrome: RealChrome;

  beforeAll(async () => {
    chrome = await startRealChrome({ "/bands": BANDS_HTML });
  }, 60_000);

  afterAll(async () => {
    await chrome.stop();
  });

  it("renders at the viewport it is given and screenshots at exactly that size", async () => {
    const { session, dispose } = await chrome.connect();
    try {
      await session.navigate(`${chrome.baseUrl}/bands`);
      await session.setViewport({ width: 1440, height: 900 });
      expect(await session.viewport()).toMatchObject({ width: 1440, height: 900, devicePixelRatio: 1 });
      const shot = await session.screenshot({ format: "png", scale: 1 });
      expect(shot).toMatchObject({ format: "png", width: 1440, height: 900 });
      expect((await session.screenshot()).format).toBe("jpeg");
    } finally {
      await dispose();
    }
  });

  it("keeps the frame in CSS pixels on a high-density screen, so a click lands where the image shows", async () => {
    const { session, dispose } = await chrome.connect();
    try {
      await session.navigate(`${chrome.baseUrl}/bands`);
      await session.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
      expect((await session.viewport()).devicePixelRatio).toBe(2);
      const shot = await session.screenshot({ format: "png", scale: 1 });
      expect(shot).toMatchObject({ width: 1440, height: 900 });
      await session.clickAt({ x: 700, y: 450 });
      expect(await session.evaluate<number[][]>("window.clicks")).toEqual([[700, 450]]);
    } finally {
      await dispose();
    }
  });

  it("captures what is on screen after scrolling, not the top of the page", async () => {
    const { session, dispose } = await chrome.connect();
    try {
      await session.navigate(`${chrome.baseUrl}/bands`);
      await session.setViewport({ width: 800, height: 600 });
      expect(await pixel(session, (await session.screenshot({ format: "png", scale: 1 })).base64!, 10, 10)).toEqual([255, 0, 0]);
      await session.evaluate("scrollTo(0, 1000)");
      const shot = await session.screenshot({ format: "png", scale: 1 });
      expect(await pixel(session, shot.base64!, 10, 10)).toEqual([0, 255, 0]);
    } finally {
      await dispose();
    }
  });

  it("zooms into a region and returns it enlarged", async () => {
    const { session, dispose } = await chrome.connect();
    try {
      await session.navigate(`${chrome.baseUrl}/bands`);
      await session.setViewport({ width: 1440, height: 900 });
      const zoomed = await session.screenshot({ format: "png", region: { x: 100, y: 100, width: 360, height: 225 }, scale: 4 });
      expect(zoomed).toMatchObject({ width: 1440, height: 900 });
      const half = await session.screenshot({ format: "png", scale: 0.5 });
      expect(half).toMatchObject({ width: 720, height: 450 });
    } finally {
      await dispose();
    }
  });
});
