import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromePath, startRealChrome, type RealChrome } from "../helpers/real-chrome.js";
import { AnthropicBrowserExecutor, type ToolResultBlock } from "../../src/agent-tools/computer-use/index.js";
import { pngSize } from "../../src/agent-tools/index.js";

const HALT = "Not executed: an earlier action in this turn failed.";

const FORM_HTML = `<!doctype html><html><head><title>Form</title></head><body style="margin:0">
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'sent ' + document.getElementById('q').value">
  <input id="q" aria-label="Search" style="display:block;width:300px;height:30px">
  <label><input id="agree" type="checkbox"> Agree</label>
  <select id="size" aria-label="Size"><option value="s">Small</option><option value="l">Large</option></select>
</form>
<p id="out"></p>
<a id="pop" href="/second" target="_blank">Open second</a>
<a id="dl" href="/file">Get file</a>
<div id="box" style="width:300px;height:100px;overflow:scroll"><div style="width:2000px;height:2000px"></div></div>
<script>console.warn("hello from page"); fetch("/api?token=abc");</script>
</body></html>`;
const SECOND_HTML = `<!doctype html><html><head><title>Second</title></head><body>second</body></html>`;

let n = 0;
const call = (name: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id: `toolu_${++n}`, name, toolset_name: "browser", input });
const textOf = (r: ToolResultBlock) => r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
const stateOf = (r: ToolResultBlock) => r.content.find((c) => c.type === "browser_state") as
  | { tabs: Array<{ tab_id: string; title: string; url: string; active?: boolean }>; state_changes?: Array<Record<string, unknown>> }
  | undefined;

describe.skipIf(!chromePath)("Claude browser toolset executor against a real Chrome", () => {
  let chrome: RealChrome;
  let downloads: string;
  let exec: AnthropicBrowserExecutor;

  beforeAll(async () => {
    downloads = await mkdtemp(join(tmpdir(), "bg-cu-dl-"));
    chrome = await startRealChrome({
      "/form": FORM_HTML,
      "/second": SECOND_HTML,
      "/file": { body: "a,b", headers: { "content-type": "text/csv", "content-disposition": "attachment; filename=list.csv" } },
      "/api?token=abc": { body: "{}", headers: { "content-type": "application/json" } },
    });
  }, 60_000);

  afterAll(async () => {
    await chrome.stop();
    await rm(downloads, { recursive: true, force: true });
  });

  async function fresh(extra: Record<string, unknown> = {}) {
    exec = await AnthropicBrowserExecutor.connect({
      endpoint: chrome.browserWsUrl,
      startUrl: `${chrome.baseUrl}/form`,
      urls: { blockPrivateNetworks: false },
      ...extra,
    });
    return exec;
  }

  async function refFor(pattern: RegExp): Promise<string> {
    const [res] = await exec.run([call("read_page", { filter: "all" })]);
    const ref = new RegExp(`${pattern.source}[^\\n]*\\[(e\\d+)\\]`).exec(textOf(res!))?.[1];
    if (!ref) throw new Error(`no ref for ${pattern} in:\n${textOf(res!)}`);
    return ref;
  }

  it("declares only the optional members it runs", async () => {
    await fresh();
    try {
      expect(exec.declaration()).toEqual({ type: "browser_toolset_20260801" });
      const withLogs = await AnthropicBrowserExecutor.connect({ endpoint: chrome.browserWsUrl, logs: true, javascript: true });
      expect(withLogs.declaration().configs).toEqual({
        read_console: { enabled: true },
        read_network: { enabled: true },
        javascript_exec: { enabled: true },
      });
      await withLogs.close();
    } finally {
      await exec.close();
    }
  });

  it("runs a batch in order, echoing the toolset on every result", async () => {
    await fresh();
    try {
      const search = await refFor(/textbox "Search"/);
      const results = await exec.run([
        { type: "text", text: "I'll search." },
        call("left_click", { target: { type: "ref", ref: search } }),
        call("type", { text: "cats" }),
        call("key", { text: "Enter" }),
        { type: "tool_use", id: "own_tool", name: "lookup", input: {} },
      ]);
      expect(results).toHaveLength(3);
      for (const r of results) expect(r).toMatchObject({ type: "tool_result", toolset_name: "browser" });
      expect(results.every((r) => !r.is_error)).toBe(true);
      expect(textOf(results[0]!)).toBe(`Clicked element ${search}.`);
      expect(await exec.session.agent.evaluate("document.getElementById('out').textContent")).toBe("sent cats");
    } finally {
      await exec.close();
    }
  });

  it("stops at the first failure and answers the rest with the exact halt text", async () => {
    await fresh();
    try {
      const results = await exec.run([
        call("left_click", { target: { type: "ref", ref: "e999" } }),
        call("type", { text: "never" }),
        call("screenshot"),
      ]);
      expect(results[0]).toMatchObject({ is_error: true });
      expect(textOf(results[0]!)).toBe("Error: e999 is stale or not found on the current page. Re-read the page to get fresh references.");
      for (const r of results.slice(1)) expect(r).toEqual({ type: "tool_result", tool_use_id: r.tool_use_id, toolset_name: "browser", content: [{ type: "text", text: HALT }], is_error: true });
      for (const r of results) expect(stateOf(r)).toBeUndefined();
    } finally {
      await exec.close();
    }
  });

  it("returns screenshots at the frame size and refuses clicks outside it", async () => {
    await fresh();
    try {
      const [shot, zoom, outside] = await Promise.all([
        exec.run([call("screenshot")]),
        Promise.resolve(null),
        Promise.resolve(null),
      ]).then(async ([s]) => [s, await exec.run([call("zoom", { region: [0, 0, 360, 225] })]), await exec.run([call("left_click", { target: { type: "coordinate", x: 5000, y: 10 } })])]);
      const img = shot![0]!.content[0] as { type: string; source: { media_type: string; data: string } };
      expect(img.type).toBe("image");
      expect(pngSize(img.source.data)).toEqual({ width: 1440, height: 900 });
      expect(pngSize((zoom![0]!.content[0] as typeof img).source.data)).toEqual({ width: 1440, height: 900 });
      expect(outside![0]).toMatchObject({ is_error: true });
      expect(textOf(outside![0]!)).toMatch(/outside the 1440x900 screenshot/);
    } finally {
      await exec.close();
    }
  });

  it("answers tab calls with exactly one browser_state block", async () => {
    await fresh();
    try {
      const [opened] = await exec.run([call("new_tab")]);
      expect(opened!.content).toHaveLength(1);
      const state = stateOf(opened!)!;
      const active = state.tabs.filter((t) => t.active);
      expect(active).toHaveLength(1);
      expect(state.state_changes).toEqual([{ type: "tab_opened", tab_id: active[0]!.tab_id }]);
      const [listed] = await exec.run([call("list_tabs")]);
      expect(listed!.content).toHaveLength(1);
      expect(stateOf(listed!)!.state_changes).toBeUndefined();
      const first = state.tabs.find((t) => !t.active)!.tab_id;
      const [switched] = await exec.run([call("switch_tab", { tab_id: first })]);
      expect(stateOf(switched!)!.tabs.find((t) => t.active)?.tab_id).toBe(first);
      const [closed] = await exec.run([call("close_tab", { tab_id: active[0]!.tab_id })]);
      expect(stateOf(closed!)!.tabs).toHaveLength(1);
      const [bad] = await exec.run([call("switch_tab", { tab_id: "nope" })]);
      expect(bad).toMatchObject({ is_error: true });
      expect(stateOf(bad!)).toBeUndefined();
    } finally {
      await exec.close();
    }
  });

  it("reports a tab a click opened, keeping the opener active", async () => {
    await fresh();
    try {
      const link = await refFor(/link "Open second"/);
      const [res] = await exec.run([call("left_click", { target: { type: "ref", ref: link } })]);
      const state = stateOf(res!)!;
      expect(textOf(res!)).toBe(`Clicked element ${link}.`);
      expect(state.tabs).toHaveLength(2);
      expect(state.tabs.find((t) => t.active)?.title).toBe("Form");
      const opened = state.state_changes?.find((c) => c.type === "tab_opened");
      expect(state.tabs.find((t) => t.tab_id === opened?.tab_id)?.url).toBe(`${chrome.baseUrl}/second`);
    } finally {
      await exec.close();
    }
  });

  it("refuses non-web addresses with the documented message and moves through history", async () => {
    await fresh();
    try {
      const [refused] = await exec.run([call("navigate", { url: "javascript:alert(1)" })]);
      expect(textOf(refused!)).toBe("Error: Navigation refused. Only http and https URLs are allowed.");
      const [went] = await exec.run([call("navigate", { url: `${chrome.baseUrl}/second` })]);
      expect(stateOf(went!)!.tabs[0]).toMatchObject({ title: "Second", active: true });
      const [back] = await exec.run([call("navigate", { url: "back" })]);
      expect(textOf(back!)).toBe(`Went back to ${chrome.baseUrl}/form.`);
    } finally {
      await exec.close();
    }
  });

  it("sets form values by ref: checkbox, dropdown and text", async () => {
    await fresh();
    try {
      const agree = await refFor(/checkbox "Agree"/);
      const size = await refFor(/combobox "Size"/);
      const search = await refFor(/textbox "Search"/);
      const results = await exec.run([
        call("form_input", { target: { type: "ref", ref: agree }, value: true }),
        call("form_input", { target: { type: "ref", ref: size }, value: "Large" }),
        call("form_input", { target: { type: "ref", ref: search }, value: 42 }),
      ]);
      expect(results.every((r) => !r.is_error)).toBe(true);
      expect(await exec.session.agent.evaluate("[agree.checked, size.value, q.value].join(',')")).toBe("true,l,42");
    } finally {
      await exec.close();
    }
  });

  it("scrolls the element under a point and finds elements by description", async () => {
    await fresh();
    try {
      const [scrolled] = await exec.run([call("scroll", { target: { type: "coordinate", x: 100, y: 200 }, scroll_direction: "down", scroll_amount: 2 })]);
      expect(scrolled!.is_error).toBeUndefined();
      const [found] = await exec.run([call("find", { query: "search box" })]);
      expect(textOf(found!).split("\n")[0]).toMatch(/^textbox "Search" \[e\d+\]$/);
    } finally {
      await exec.close();
    }
  });

  it("keeps logs off unless enabled, and redacts secrets when on", async () => {
    await fresh();
    try {
      const [off] = await exec.run([call("read_console")]);
      expect(off).toMatchObject({ is_error: true });
    } finally {
      await exec.close();
    }
    await fresh({ logs: true, session: { } });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const [network] = await exec.run([call("read_network")]);
      expect(textOf(network!)).toContain(`GET ${chrome.baseUrl}/api?... 200`);
      expect(textOf(network!)).not.toContain("abc");
      const [again] = await exec.run([call("read_network")]);
      expect(textOf(again!)).toBe("No new network requests.");
    } finally {
      await exec.close();
    }
  });

  it("reports a download as started, then completed, by download id", async () => {
    await fresh({ downloadPath: downloads });
    try {
      const file = await refFor(/link "Get file"/);
      const [clicked] = await exec.run([call("left_click", { target: { type: "ref", ref: file } })]);
      const changes = stateOf(clicked!)?.state_changes ?? [];
      const started = changes.find((c) => c.type === "download_started");
      expect(started).toMatchObject({ url: `${chrome.baseUrl}/file` });
      let completed = changes.find((c) => c.type === "download_completed");
      for (let i = 0; i < 20 && !completed; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const [waited] = await exec.run([call("wait", { duration: 0 })]);
        completed = stateOf(waited!)?.state_changes?.find((c) => c.type === "download_completed");
      }
      expect(completed).toMatchObject({ download_id: started!.download_id });
    } finally {
      await exec.close();
    }
  });
});
