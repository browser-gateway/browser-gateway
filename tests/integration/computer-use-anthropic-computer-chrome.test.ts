import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromePath, startRealChrome, type RealChrome } from "../helpers/real-chrome.js";
import { AnthropicComputerExecutor, type ToolResultBlock } from "../../src/agent-tools/computer-use/index.js";
import { pngSize } from "../../src/agent-tools/index.js";

const HALT = "Not executed: an earlier computer action in this turn failed.";
const PAGE_HTML = `<!doctype html><html><head><title>Desk</title></head><body style="margin:0">
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'sent ' + q.value">
  <input id="q" style="position:absolute;left:0;top:0;width:400px;height:40px">
</form>
<div id="slider" style="position:absolute;left:500px;top:100px;width:400px;height:40px;background:#ccc"></div>
<p id="out" style="position:absolute;top:300px"></p>
<script>window.clicks=[];addEventListener("mousedown",(e)=>clicks.push({x:e.clientX,y:e.clientY,shift:e.shiftKey}));
let drag=false;slider.addEventListener("mousedown",()=>drag=true);addEventListener("mouseup",(e)=>{if(drag){drag=false;window.dropX=e.clientX;}});</script>
</body></html>`;

let n = 0;
const member = (name: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id: `t${++n}`, name, toolset_name: "computer", input });
const legacy = (action: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id: `l${++n}`, name: "computer", input: { action, ...input } });
const textOf = (r: ToolResultBlock) => r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");

describe.skipIf(!chromePath)("Claude computer use executor against a real Chrome", () => {
  let chrome: RealChrome;

  beforeAll(async () => {
    chrome = await startRealChrome({ "/desk": PAGE_HTML });
  }, 60_000);

  afterAll(async () => {
    await chrome.stop();
  });

  const connect = (legacyShape = false) =>
    AnthropicComputerExecutor.connect({ endpoint: chrome.browserWsUrl, startUrl: `${chrome.baseUrl}/desk`, urls: { blockPrivateNetworks: false }, legacy: legacyShape });

  it("declares the toolset, or the earlier tool with the display size", async () => {
    const toolset = await connect();
    const old = await connect(true);
    try {
      expect(toolset.declaration()).toEqual({ type: "computer_toolset_20260801" });
      expect(old.declaration()).toEqual({ type: "computer_20251124", name: "computer", display_width_px: 1440, display_height_px: 900, enable_zoom: true });
    } finally {
      await toolset.close();
      await old.close();
    }
  });

  it("clicks, types and presses keys, echoing the toolset, with modifiers held for a click", async () => {
    const exec = await connect();
    try {
      const results = await exec.run([
        member("left_click", { coordinate: [100, 20] }),
        member("type", { text: "dogs" }),
        member("key", { text: "Return" }),
        member("left_click", { coordinate: [600, 200], text: "shift" }),
      ]);
      for (const r of results) expect(r).toMatchObject({ toolset_name: "computer" });
      expect(results.every((r) => !r.is_error)).toBe(true);
      expect(await exec.session.agent.evaluate("document.getElementById('out').textContent")).toBe("sent dogs");
      expect(await exec.session.agent.evaluate("window.clicks.at(-1)")).toEqual({ x: 600, y: 200, shift: true });
    } finally {
      await exec.close();
    }
  });

  it("stops at the first failure with the computer halt text", async () => {
    const exec = await connect();
    try {
      const results = await exec.run([member("left_click", { coordinate: [9000, 10] }), member("screenshot")]);
      expect(results[0]).toMatchObject({ is_error: true });
      expect(results[1]).toEqual({ type: "tool_result", tool_use_id: results[1]!.tool_use_id, toolset_name: "computer", content: [{ type: "text", text: HALT }], is_error: true });
    } finally {
      await exec.close();
    }
  });

  it("reports the cursor and drags with the button held at the cursor", async () => {
    const exec = await connect();
    try {
      const [pos] = await exec.run([member("mouse_move", { coordinate: [520, 120] }), member("cursor_position")]).then((r) => r.slice(1));
      expect(textOf(pos!)).toBe("X=520, Y=120");
      await exec.run([member("left_mouse_down"), member("mouse_move", { coordinate: [800, 120] }), member("left_mouse_up")]);
      expect(await exec.session.agent.evaluate<number>("window.dropX")).toBe(800);
      await exec.run([member("left_click_drag", { start_coordinate: [520, 120], coordinate: [650, 120] })]);
      expect(await exec.session.agent.evaluate<number>("window.dropX")).toBe(650);
    } finally {
      await exec.close();
    }
  });

  it("answers the earlier tool shape without a toolset name", async () => {
    const exec = await connect(true);
    try {
      const results = await exec.run([legacy("screenshot"), member("screenshot"), legacy("left_click", { coordinate: [100, 20] })]);
      expect(results).toHaveLength(2);
      expect(results[0]).not.toHaveProperty("toolset_name");
      const img = results[0]!.content[0] as { source: { data: string } };
      expect(pngSize(img.source.data)).toEqual({ width: 1440, height: 900 });
      expect(textOf(results[1]!)).toBe("Clicked at (100, 20).");
    } finally {
      await exec.close();
    }
  });

  it("refuses an action it does not know with an error result", async () => {
    const exec = await connect();
    try {
      const [res] = await exec.run([member("open_terminal")]);
      expect(res).toMatchObject({ is_error: true });
      expect(textOf(res!)).toMatch(/not a computer action this executor runs/);
    } finally {
      await exec.close();
    }
  });
});
