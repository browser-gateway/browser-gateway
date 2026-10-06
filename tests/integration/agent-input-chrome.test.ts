import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromePath, startRealChrome, type RealChrome } from "../helpers/real-chrome.js";

const INPUT_HTML = `<!doctype html><html><head><title>Input fixture</title>
<style>body{margin:0}#pad{position:absolute;left:0;top:0;width:400px;height:300px;background:#eee}
#box{position:absolute;left:0;top:320px;width:300px;height:150px;overflow:scroll}
#inner{width:2000px;height:2000px}
#ta{position:absolute;left:0;top:500px;width:300px;height:80px}
#slider{position:absolute;left:420px;top:0;width:300px;height:40px;background:#ccc}</style></head><body>
<div id="pad"></div><div id="box"><div id="inner"></div></div><textarea id="ta"></textarea><div id="slider"></div>
<script>
window.log = [];
const pad = document.getElementById("pad");
for (const type of ["mousedown", "mouseup", "click", "dblclick", "contextmenu", "auxclick"]) {
  pad.addEventListener(type, (e) => {
    if (type === "contextmenu") e.preventDefault();
    log.push({ type, button: e.button, detail: e.detail, x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey });
  });
}
const ta = document.getElementById("ta");
ta.addEventListener("keydown", (e) => log.push({ type: "keydown", key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey }));
const slider = document.getElementById("slider");
let dragging = false;
slider.addEventListener("mousedown", () => { dragging = true; log.push({ type: "drag-start" }); });
window.addEventListener("mousemove", (e) => { if (dragging && e.buttons === 1) window.dragX = e.clientX; });
window.addEventListener("mouseup", (e) => { if (dragging) { dragging = false; log.push({ type: "drag-end", x: e.clientX }); } });
</script></body></html>`;

const PAGE_A = `<!doctype html><html><head><title>A</title></head><body><a id="next" href="/b">to b</a></body></html>`;
const PAGE_B = `<!doctype html><html><head><title>B</title></head><body>page b</body></html>`;

type LogEntry = Record<string, unknown> & { type: string };

describe.skipIf(!chromePath)("agent input primitives against a real Chrome", () => {
  let chrome: RealChrome;

  beforeAll(async () => {
    chrome = await startRealChrome({ "/input": INPUT_HTML, "/a": PAGE_A, "/b": PAGE_B });
  }, 60_000);

  afterAll(async () => {
    await chrome.stop();
  });

  async function openInput() {
    const handle = await chrome.connect();
    await handle.session.navigate(`${chrome.baseUrl}/input`);
    const log = async (): Promise<LogEntry[]> => (await handle.session.evaluate<LogEntry[]>("window.log")) ?? [];
    return { ...handle, log };
  }

  it("clicks at a point with the right button, the middle button and a modifier", async () => {
    const { session, log, dispose } = await openInput();
    try {
      await session.clickAt({ x: 50, y: 60 }, { button: "right" });
      await session.clickAt({ x: 70, y: 80 }, { button: "middle" });
      await session.clickAt({ x: 90, y: 100 }, { modifiers: ["Shift"] });
      const events = await log();
      expect(events.find((e) => e.type === "contextmenu")).toMatchObject({ button: 2, x: 50, y: 60 });
      expect(events.find((e) => e.type === "auxclick" && e.button === 1)).toMatchObject({ x: 70, y: 80 });
      expect(events.find((e) => e.type === "click")).toMatchObject({ button: 0, shift: true, x: 90, y: 100 });
    } finally {
      await dispose();
    }
  });

  it("double and triple clicks report the click count the page expects", async () => {
    const { session, log, dispose } = await openInput();
    try {
      await session.clickAt({ x: 100, y: 100 }, { clickCount: 2 });
      await session.clickAt({ x: 200, y: 200 }, { clickCount: 3 });
      const events = await log();
      expect(events.filter((e) => e.type === "dblclick")).toHaveLength(2);
      expect(events.filter((e) => e.type === "mousedown").map((e) => e.detail)).toEqual([1, 2, 1, 2, 3]);
    } finally {
      await dispose();
    }
  });

  it("keeps the mouse button held between separate calls so a drag spans them", async () => {
    const { session, log, dispose } = await openInput();
    try {
      await session.mouseDown({ x: 430, y: 20 });
      await session.mouseMove({ x: 520, y: 20 });
      await session.mouseMove({ x: 600, y: 20 });
      expect(await session.evaluate<number>("window.dragX")).toBe(600);
      await session.mouseUp({ x: 610, y: 20 });
      expect((await log()).find((e) => e.type === "drag-end")).toMatchObject({ x: 610 });
      await session.drag({ x: 440, y: 20 }, { x: 700, y: 20 });
      expect((await log()).filter((e) => e.type === "drag-end").pop()).toMatchObject({ x: 700 });
    } finally {
      await dispose();
    }
  });

  it("scrolls the element under the pointer in both directions", async () => {
    const { session, dispose } = await openInput();
    try {
      await session.wheel({ x: 100, y: 380 }, 250, 400);
      await new Promise((r) => setTimeout(r, 300));
      const pos = await session.evaluate<{ top: number; left: number }>(
        "({ top: document.getElementById('box').scrollTop, left: document.getElementById('box').scrollLeft })",
      );
      expect(pos?.top).toBeGreaterThan(0);
      expect(pos?.left).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  it("presses key chords, sequences and keys held across calls", async () => {
    const { session, log, dispose } = await openInput();
    try {
      await session.clickAt({ x: 100, y: 540 });
      await session.pressKeys("h i");
      await session.pressKeys("shift+a");
      expect(await session.evaluate<string>("document.getElementById('ta').value")).toBe("hiA");
      await session.pressKeys(["Control", "a"]);
      await session.pressKeys("BackSpace");
      expect(await session.evaluate<string>("document.getElementById('ta').value")).toBe("");
      await session.keyDown("ctrl");
      await session.clickAt({ x: 60, y: 60 });
      await session.keyUp("ctrl");
      const events = await log();
      expect(events.find((e) => e.type === "keydown" && e.key === "a" && e.ctrl)).toBeTruthy();
      expect(events.filter((e) => e.type === "mousedown").pop()).toMatchObject({ ctrl: true });
      await session.clickAt({ x: 100, y: 540 });
      await session.pressKeys("Return", 2);
      expect(await session.evaluate<string>("document.getElementById('ta').value")).toBe("\n\n");
    } finally {
      await dispose();
    }
  });

  it("rejects an unknown key name instead of sending a wrong key", async () => {
    const { session, dispose } = await openInput();
    try {
      await expect(session.pressKeys("NotAKey")).rejects.toThrow(/unknown key/);
    } finally {
      await dispose();
    }
  });

  it("goes back, forward and reloads, and says when there is no earlier page", async () => {
    const handle = await chrome.connect();
    try {
      const { session } = handle;
      await expect(session.history("back")).rejects.toThrow(/no earlier page/);
      await session.navigate(`${chrome.baseUrl}/a`);
      await session.navigate(`${chrome.baseUrl}/b`);
      expect((await session.history("back")).title).toBe("A");
      expect((await session.history("forward")).title).toBe("B");
      expect((await session.history("reload")).url).toBe(`${chrome.baseUrl}/b`);
    } finally {
      await handle.dispose();
    }
  });
});
