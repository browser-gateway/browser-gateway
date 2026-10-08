import { describe, expect, it, vi } from "vitest";
import {
  AGENT_TOOL_DEFINITIONS,
  agentInstructions,
  detectBlockedPage,
  fetchPage,
  screenshotPage,
  type AgentSession,
} from "../../src/agent-tools/index.js";

function fakeAgent(page: { url: string; title: string; text: string }, opts: { waitFails?: boolean } = {}) {
  const calls: string[] = [];
  const agent = {
    goto: vi.fn(async (url: string) => {
      calls.push(`goto ${url}`);
      return { tabId: "t1", url: page.url, title: page.title };
    }),
    waitFor: vi.fn(async () => {
      calls.push("wait");
      if (opts.waitFails) throw new Error("timed out");
      return { met: true, waitedMs: 5 };
    }),
    extract: vi.fn(async (o: { format?: string; maxChars?: number }) => {
      calls.push(`extract ${o.format} ${o.maxChars}`);
      return { format: o.format ?? "markdown", text: page.text, truncated: false };
    }),
    screenshot: vi.fn(async () => {
      calls.push("screenshot");
      return { base64: "aGk=", bytes: 2, format: "jpeg", unchanged: false };
    }),
  };
  return { agent: agent as unknown as AgentSession, calls };
}

describe("detectBlockedPage", () => {
  it("names bot checks, captchas, access-denied pages and login walls", () => {
    expect(detectBlockedPage({ url: "https://a.com", title: "Just a moment...", text: "" })).toContain("bot check");
    expect(detectBlockedPage({ url: "https://a.com", title: "x", text: "Please verify you are human" })).toContain("captcha");
    expect(detectBlockedPage({ url: "https://a.com", title: "x", text: "Access is temporarily restricted" })).toContain(
      "access-denied",
    );
    expect(detectBlockedPage({ url: "https://a.com", title: "x", text: "Sign in to continue" })).toContain("login wall");
  });

  it("flags pages the browser could not load and empty pages that ask for JavaScript", () => {
    expect(detectBlockedPage({ url: "chrome-error://chromewebdata/", title: "", text: "" })).toContain("could not load");
    expect(detectBlockedPage({ url: "https://a.com", title: "App", text: "You need to enable JavaScript to run this app." })).toContain(
      "JavaScript",
    );
  });

  it("leaves real pages alone, including forms that only mention a captcha provider", () => {
    expect(detectBlockedPage({ url: "https://a.com", title: "Docs", text: "A long article about web browsers." })).toBeUndefined();
    expect(
      detectBlockedPage({ url: "https://a.com", title: "Contact", text: "This site is protected by reCAPTCHA and the Google Privacy Policy." }),
    ).toBeUndefined();
    const longJsPage = `Enable JavaScript for the best experience. ${"Real content. ".repeat(50)}`;
    expect(detectBlockedPage({ url: "https://a.com", title: "News", text: longJsPage })).toBeUndefined();
  });
});

describe("fetchPage", () => {
  it("loads, reads markdown with a generous default size, and reports no block on real content", async () => {
    const { agent, calls } = fakeAgent({ url: "https://a.com/final", title: "A", text: "Hello world" });
    const result = await fetchPage(agent, { url: "https://a.com" });
    expect(calls).toEqual(["goto https://a.com", "extract markdown 20000"]);
    expect(result).toEqual({ url: "https://a.com/final", title: "A", format: "markdown", text: "Hello world", truncated: false });
  });

  it("waits for late text when asked and says so when it never came", async () => {
    const { agent, calls } = fakeAgent({ url: "https://a.com", title: "A", text: "x" }, { waitFails: true });
    const result = await fetchPage(agent, { url: "https://a.com", waitForText: "Price", format: "text", maxChars: 50 });
    expect(calls).toEqual(["goto https://a.com", "wait", "extract text 50"]);
    expect(result.waitTimedOut).toBe(true);
  });

  it("returns a blocked hint with the content when the page is a bot check", async () => {
    const { agent } = fakeAgent({ url: "https://a.com", title: "Just a moment...", text: "Checking your browser" });
    expect((await fetchPage(agent, { url: "https://a.com" })).blocked).toContain("bot check");
  });
});

describe("screenshotPage", () => {
  it("captures after loading and checks the page text for a block", async () => {
    const { agent, calls } = fakeAgent({ url: "https://a.com", title: "A", text: "Access denied" });
    const result = await screenshotPage(agent, { url: "https://a.com", fullPage: true });
    expect(calls).toEqual(["goto https://a.com", "screenshot", "extract text 2000"]);
    expect(result.image.base64).toBe("aGk=");
    expect(result.blocked).toContain("access-denied");
  });
});

describe("agent tool wording", () => {
  it("keeps every description short enough for clients that cut long ones", () => {
    for (const tool of AGENT_TOOL_DEFINITIONS) expect(tool.description.length, tool.name).toBeLessThanOrEqual(450);
  });

  it("never tells the agent to avoid a tool and gives every tool a title", () => {
    for (const tool of AGENT_TOOL_DEFINITIONS) {
      expect(tool.description, tool.name).not.toMatch(/only when/i);
      expect(tool.annotations.title.length, tool.name).toBeGreaterThan(2);
    }
  });

  it("puts the one-call tools first and loads only the screenshot tool up front", () => {
    expect(AGENT_TOOL_DEFINITIONS.slice(0, 2).map((t) => t.name)).toEqual(["fetch_page", "screenshot_page"]);
    expect(AGENT_TOOL_DEFINITIONS.filter((t) => t.alwaysLoad).map((t) => t.name)).toEqual(["screenshot_page"]);
  });

  it("tells the agent to try the built-in fetch first on ordinary pages", () => {
    expect(AGENT_TOOL_DEFINITIONS[0]!.description).toContain("try the built-in web fetch first");
  });

  it("names the words people use and the fallback case", () => {
    const fetchDesc = AGENT_TOOL_DEFINITIONS[0]!.description;
    expect(fetchDesc).toMatch(/web fetch failed/);
    expect(fetchDesc).toMatch(/JavaScript/);
    expect(AGENT_TOOL_DEFINITIONS[1]!.description).toMatch(/screenshot of a website/);
  });

  it("opens the server instructions with when to use these tools", () => {
    const first = agentInstructions().split("\n")[0]!;
    expect(first).toContain("screenshot of a website");
    expect(first).toContain("web fetch failed");
  });
});
