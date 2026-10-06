import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromePath, startRealChrome, type RealChrome } from "../helpers/real-chrome.js";
import {
  AnthropicBrowserExecutor,
  AnthropicComputerExecutor,
  GeminiExecutor,
  runClaudeLoop,
  runGeminiLoop,
  type ToolResultBlock,
} from "../../src/agent-tools/computer-use/index.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "computer-use-fixtures", name), "utf8")) as unknown[][];

const SEARCH_HTML = `<!doctype html><html><head><title>Computer - Wikipedia</title></head><body style="margin:0">
<form onsubmit="event.preventDefault(); location.href = '/wiki/Grace_Hopper'">
  <input id="q" aria-label="Search Wikipedia" style="position:absolute;left:300px;top:15px;width:800px;height:40px">
</form></body></html>`;
const ARTICLE_HTML = `<!doctype html><html><head><title>Grace Hopper - Wikipedia</title></head><body><h1>Grace Hopper</h1><p>Born December 9, 1906.</p></body></html>`;

describe.skipIf(!chromePath)("replaying recorded model turns through the loop helpers", () => {
  let chrome: RealChrome;
  const urls = { blockPrivateNetworks: false };

  beforeAll(async () => {
    chrome = await startRealChrome({ "/wiki/Computer": SEARCH_HTML, "/wiki/Grace_Hopper": ARTICLE_HTML });
  }, 60_000);

  afterAll(async () => {
    await chrome.stop();
  });

  for (const [label, file, make] of [
    ["Claude browser tool", "claude-browser-turns.json", () => AnthropicBrowserExecutor.connect({ endpoint: chrome.browserWsUrl, startUrl: `${chrome.baseUrl}/wiki/Computer`, urls })],
    ["Claude computer tool", "claude-computer-turns.json", () => AnthropicComputerExecutor.connect({ endpoint: chrome.browserWsUrl, startUrl: `${chrome.baseUrl}/wiki/Computer`, urls })],
  ] as const) {
    it(`runs a recorded ${label} search to the article, answering every call`, async () => {
      const exec = await make();
      const turns = fixture(file);
      const requests: Array<{ tools: unknown[]; messages: unknown[] }> = [];
      try {
        const result = await runClaudeLoop({
          executor: exec,
          task: "Find Grace Hopper's year of birth.",
          createMessage: async (request) => {
            requests.push(request);
            const next = turns[requests.length - 1];
            return next ? { content: next, stop_reason: "tool_use" } : { content: [{ type: "text", text: "1906" }], stop_reason: "end_turn" };
          },
        });
        expect(result).toMatchObject({ text: "1906", turns: turns.length + 1, stoppedBy: "done" });
        expect(requests[0]!.tools).toEqual([exec.declaration()]);
        const results = result.transcript.filter((m) => m.role === "user" && Array.isArray(m.content)).flatMap((m) => m.content as ToolResultBlock[]);
        expect(results.length).toBe(turns.flat().length);
        expect(results.filter((r) => r.is_error)).toEqual([]);
        expect((await exec.session.agent.tabInventory())[0]?.url).toBe(`${chrome.baseUrl}/wiki/Grace_Hopper`);
      } finally {
        await exec.close();
      }
    }, 30_000);
  }

  it("runs a recorded Gemini search to the article", async () => {
    const exec = await GeminiExecutor.connect({ endpoint: chrome.browserWsUrl, startUrl: `${chrome.baseUrl}/wiki/Computer`, urls });
    const turns = fixture("gemini-turns.json");
    let call = 0;
    try {
      const result = await runGeminiLoop({
        executor: exec,
        task: "Find Grace Hopper's year of birth.",
        generateContent: async ({ contents }) => {
          if (call === 0) expect(contents[0]!.parts.some((p) => typeof p === "object" && p !== null && "inlineData" in p)).toBe(true);
          const next = turns[call++];
          return { candidates: [{ content: { role: "model", parts: next ?? [{ text: "1906" }] } }] };
        },
      });
      expect(result).toMatchObject({ text: "1906", stoppedBy: "done" });
      const responses = result.transcript.filter((c) => c.role === "user").flatMap((c) => c.parts).filter((p) => typeof p === "object" && p !== null && "functionResponse" in p) as Array<{ functionResponse: { response: Record<string, unknown> } }>;
      expect(responses).toHaveLength(2);
      expect(responses.every((r) => r.functionResponse.response.error === undefined)).toBe(true);
      expect(responses.at(-1)!.functionResponse.response.url).toBe(`${chrome.baseUrl}/wiki/Grace_Hopper`);
    } finally {
      await exec.close();
    }
  }, 30_000);

  it("stops at the turn limit", async () => {
    const exec = await AnthropicBrowserExecutor.connect({ endpoint: chrome.browserWsUrl, startUrl: `${chrome.baseUrl}/wiki/Computer`, urls });
    try {
      const shot = { type: "tool_use", id: "s", name: "screenshot", toolset_name: "browser", input: {} };
      const result = await runClaudeLoop({ executor: exec, task: "loop", maxTurns: 2, createMessage: async () => ({ content: [shot], stop_reason: "tool_use" }) });
      expect(result).toMatchObject({ stoppedBy: "max-turns", turns: 2, text: "" });
    } finally {
      await exec.close();
    }
  });
});
