import { describe, expect, it } from "vitest";
import { flagNumber, isBrowseVerb, normaliseRef, parseBrowseArgs } from "../../src/server/browse/protocol.js";
import { connectUrl, maskToken } from "../../src/server/browse/credentials.js";

describe("browse argument parsing", () => {
  it("splits the verb, positionals and flags", () => {
    const { verb, args, flags } = parseBrowseArgs(["fill", "@e5", "headless", "browser", "--session", "work"]);
    expect(verb).toBe("fill");
    expect(args).toEqual(["@e5", "headless", "browser"]);
    expect(flags.session).toBe("work");
  });

  it("accepts --flag=value and boolean flags", () => {
    const { flags } = parseBrowseArgs(["snapshot", "--format=text", "--full", "--json"]);
    expect(flags.rest.format).toBe("text");
    expect(flags.rest.full).toBe(true);
    expect(flags.json).toBe(true);
  });

  it("defaults the session name", () => {
    expect(parseBrowseArgs(["snapshot"]).flags.session).toBe("default");
  });

  it("accepts refs with or without the @ prefix", () => {
    expect(normaliseRef("@e4")).toBe("e4");
    expect(normaliseRef("e4")).toBe("e4");
    expect(normaliseRef(undefined)).toBeUndefined();
  });

  it("reads numeric flags and ignores junk", () => {
    expect(flagNumber({ max: "40" }, "max")).toBe(40);
    expect(flagNumber({ max: "abc" }, "max")).toBeUndefined();
    expect(flagNumber({ max: true }, "max")).toBeUndefined();
  });

  it("knows which verbs exist", () => {
    expect(isBrowseVerb("open")).toBe(true);
    expect(isBrowseVerb("teleport")).toBe(false);
  });
});

describe("credentials helpers", () => {
  it("masks tokens in output", () => {
    expect(maskToken("bg_abcdefghijklmnop")).toBe("bg_a...op");
    expect(maskToken("short")).toBe("***");
    expect(maskToken(undefined)).toBe("(none)");
  });

  it("builds a connect url from an endpoint and token", () => {
    expect(connectUrl({ endpoint: "wss://cdp.example.test", token: "bg_x" })).toBe(
      "wss://cdp.example.test/v1/connect?token=bg_x",
    );
    expect(connectUrl({ endpoint: "wss://cdp.example.test/v1/connect" })).toBe("wss://cdp.example.test/v1/connect");
    expect(connectUrl({ endpoint: "ws://127.0.0.1:9222/devtools/browser/abc" })).toBe(
      "ws://127.0.0.1:9222/devtools/browser/abc",
    );
  });
});

describe("agent skill", () => {
  it("has agentskills-compatible frontmatter", async () => {
    const { renderSkillMarkdown, skillFrontmatter } = await import("../../src/server/browse/skill.js");
    const md = renderSkillMarkdown();
    expect(md.startsWith("---\n")).toBe(true);
    expect(skillFrontmatter.name).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(skillFrontmatter.description.length).toBeLessThanOrEqual(1024);
    expect(md).toContain(`name: ${skillFrontmatter.name}`);
    expect(md.split("\n").length).toBeLessThan(500);
  });

  it("renders the same session rules the MCP handshake sends", async () => {
    const { renderSkillMarkdown } = await import("../../src/server/browse/skill.js");
    const { agentInstructions } = await import("../../src/agent-tools/index.js");
    const shared = agentInstructions({ idleTimeoutS: 300 }).split("\n").find((l) => l.includes("One browser per task"))!;
    expect(renderSkillMarkdown()).toContain(shared.trim());
  });

  it("documents every browse verb", async () => {
    const { renderSkillMarkdown } = await import("../../src/server/browse/skill.js");
    const md = renderSkillMarkdown();
    for (const verb of ["open", "snapshot", "click", "fill", "extract", "screenshot", "wait", "tabs", "close"]) {
      expect(md).toContain(`browse ${verb}`);
    }
  });
});

describe("shared tool definitions", () => {
  it("keeps one list of tool names for every front door", async () => {
    const { AGENT_TOOL_NAMES, agentToolDefinition } = await import("../../src/agent-tools/index.js");
    expect(AGENT_TOOL_NAMES).toContain("browser_session");
    expect(AGENT_TOOL_NAMES.length).toBeLessThanOrEqual(12);
    expect(agentToolDefinition("browser_act")?.inputSchema.required).toEqual(["steps"]);
    expect(agentToolDefinition("nope")).toBeUndefined();
  });

  it("gives every tool a description and an object schema", async () => {
    const { AGENT_TOOL_DEFINITIONS } = await import("../../src/agent-tools/index.js");
    for (const tool of AGENT_TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
    }
  });
});
