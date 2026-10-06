import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromePath, startRealChrome, type RealChrome } from "../helpers/real-chrome.js";
import { GeminiExecutor, type GeminiFunctionResponsePart, type GeminiFunctionResult } from "../../src/agent-tools/computer-use/index.js";
import { pngSize } from "../../src/agent-tools/index.js";

const PAGE_HTML = `<!doctype html><html><head><title>Gemini</title></head><body style="margin:0">
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'sent ' + q.value">
  <input id="q" value="old" style="position:absolute;left:0;top:0;width:400px;height:40px">
</form>
<a id="pop" href="/second" target="_blank" style="position:absolute;left:0;top:100px;width:200px;height:40px">pop</a>
<div id="slider" style="position:absolute;left:500px;top:100px;width:400px;height:40px;background:#ccc"></div>
<div id="box" style="position:absolute;left:0;top:300px;width:300px;height:150px;overflow:scroll"><div style="width:3000px;height:3000px"></div></div>
<p id="out" style="position:absolute;top:500px"></p>
<script>window.hits=[];addEventListener("mousedown",(e)=>hits.push([e.clientX,e.clientY]));
let drag=false;slider.addEventListener("mousedown",()=>drag=true);addEventListener("mouseup",(e)=>{if(drag){drag=false;window.dropX=e.clientX;}});</script>
</body></html>`;
const SECOND_HTML = `<!doctype html><html><head><title>Second</title></head><body>second</body></html>`;

let n = 0;
const step = (name: string, args: Record<string, unknown> = {}) => ({ type: "function_call", id: `c${++n}`, name, arguments: { intent: "test", ...args } });
const payload = (r: GeminiFunctionResult) => JSON.parse((r.result[0] as { text: string }).text) as Record<string, unknown>;
const grid = (px: number, size: number) => Math.round((px / size) * 1000);

describe.skipIf(!chromePath)("Gemini computer-use executor against a real Chrome", () => {
  let chrome: RealChrome;
  let exec: GeminiExecutor;

  beforeAll(async () => {
    chrome = await startRealChrome({ "/page": PAGE_HTML, "/second": SECOND_HTML });
  }, 60_000);

  afterAll(async () => {
    await chrome.stop();
  });

  async function fresh(extra: Record<string, unknown> = {}) {
    exec = await GeminiExecutor.connect({ endpoint: chrome.browserWsUrl, startUrl: `${chrome.baseUrl}/page`, urls: { blockPrivateNetworks: false }, ...extra });
    return exec;
  }

  it("clicks on the 0-999 grid and answers in the Interactions API shape", async () => {
    await fresh();
    try {
      const { results, terminated } = await exec.run([step("click", { x: 500, y: 500 })]);
      expect(terminated).toBe(false);
      const r = results[0] as GeminiFunctionResult;
      expect(r).toMatchObject({ type: "function_result", name: "click", call_id: `c${n}` });
      expect(payload(r)).toEqual({ url: `${chrome.baseUrl}/page` });
      const img = r.result[1] as { type: string; data: string; mime_type: string };
      expect(img).toMatchObject({ type: "image", mime_type: "image/png" });
      expect(pngSize(img.data)).toEqual({ width: 1440, height: 900 });
      expect(await exec.session.agent.evaluate("window.hits")).toEqual([[720, 450]]);
    } finally {
      await exec.close();
    }
  });

  it("answers generateContent function calls with function response parts", async () => {
    await fresh();
    try {
      const { results } = await exec.run([{ functionCall: { id: "g1", name: "click_at", args: { x: 100, y: 100 } } }]);
      const part = results[0] as GeminiFunctionResponsePart;
      expect(part.functionResponse).toMatchObject({ id: "g1", name: "click_at", response: { url: `${chrome.baseUrl}/page` } });
      expect(part.functionResponse.parts[0]!.inlineData.mimeType).toBe("image/png");
    } finally {
      await exec.close();
    }
  });

  it("reports a failed action in its own result and still runs the rest", async () => {
    await fresh();
    try {
      const { results } = await exec.run([step("navigate", { url: "javascript:alert(1)" }), step("click", { x: 10, y: 10 })]);
      expect(results).toHaveLength(2);
      expect(payload(results[0] as GeminiFunctionResult).error).toMatch(/only http and https/);
      expect(payload(results[1] as GeminiFunctionResult).error).toBeUndefined();
    } finally {
      await exec.close();
    }
  });

  it("asks before an action marked for confirmation and stops if declined", async () => {
    const safety = { decision: "require_confirmation", explanation: "Submitting a form" };
    await fresh();
    try {
      const declined = await exec.run([step("click", { x: 10, y: 10 }), step("click", { x: 20, y: 20, safety_decision: safety }), step("click", { x: 30, y: 30 })]);
      expect(declined.terminated).toBe(true);
      expect(declined.results).toHaveLength(1);
    } finally {
      await exec.close();
    }
    const asked: string[] = [];
    await fresh({ confirm: async (req: { explanation: string }) => (asked.push(req.explanation), true) });
    try {
      const accepted = await exec.run([step("click", { x: 20, y: 20, safety_decision: safety })]);
      expect(asked).toEqual(["Submitting a form"]);
      expect(payload(accepted.results[0] as GeminiFunctionResult)).toMatchObject({ safety_acknowledgement: true });
    } finally {
      await exec.close();
    }
  });

  it("returns the caller's own functions untouched", async () => {
    await fresh();
    try {
      const own = { type: "function_call", id: "mine", name: "lookup_order", arguments: { id: 7 } };
      const { results, unhandled } = await exec.run([own]);
      expect(results).toEqual([]);
      expect(unhandled).toEqual([own]);
    } finally {
      await exec.close();
    }
  });

  it("types into a field, replacing what was there when given a point, and presses Enter", async () => {
    await fresh();
    try {
      await exec.run([step("type", { x: grid(100, 1440), y: grid(20, 900), text: "cats", press_enter: true })]);
      expect(await exec.session.agent.evaluate("document.getElementById('out').textContent")).toBe("sent cats");
      await exec.run([step("type_text_at", { x: grid(100, 1440), y: grid(20, 900), text: "dogs" })]);
      expect(await exec.session.agent.evaluate("q.value")).toBe("dogs");
    } finally {
      await exec.close();
    }
  });

  it("drags with either argument spelling and scrolls by pixels at a point", async () => {
    await fresh();
    try {
      await exec.run([step("drag_and_drop", { start_x: grid(520, 1440), start_y: grid(120, 900), end_x: grid(800, 1440), end_y: grid(120, 900) })]);
      expect(await exec.session.agent.evaluate<number>("window.dropX")).toBe(Math.floor((grid(800, 1440) / 1000) * 1440));
      await exec.run([step("drag_and_drop", { x: grid(520, 1440), y: grid(120, 900), destination_x: grid(700, 1440), destination_y: grid(120, 900) })]);
      expect(await exec.session.agent.evaluate<number>("window.dropX")).toBe(Math.floor((grid(700, 1440) / 1000) * 1440));
      await exec.run([step("scroll", { x: grid(100, 1440), y: grid(350, 900), direction: "down", magnitude_in_pixels: 250 })]);
      expect(await exec.session.agent.evaluate<number>("document.getElementById('box').scrollTop")).toBe(250);
    } finally {
      await exec.close();
    }
  });

  it("keeps one tab: a page a click opens replaces the current one", async () => {
    await fresh();
    try {
      const { results } = await exec.run([step("click", { x: grid(50, 1440), y: grid(120, 900) })]);
      expect(payload(results[0] as GeminiFunctionResult).url).toBe(`${chrome.baseUrl}/second`);
      expect(await exec.session.agent.tabInventory()).toHaveLength(1);
    } finally {
      await exec.close();
    }
  });

  it("presses key combinations in both forms", async () => {
    await fresh();
    try {
      await exec.run([step("click", { x: grid(100, 1440), y: grid(20, 900) }), step("hotkey", { keys: ["control", "a"] }), step("press_key", { key: "Backspace" })]);
      expect(await exec.session.agent.evaluate("q.value")).toBe("");
      await exec.run([step("type", { text: "xyz" }), step("key_combination", { keys: "Control+A" }), step("press_key", { key: "Delete" })]);
      expect(await exec.session.agent.evaluate("q.value")).toBe("");
    } finally {
      await exec.close();
    }
  });
});
