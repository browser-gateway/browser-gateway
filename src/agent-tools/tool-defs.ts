export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const sessionId = { type: "string", description: "Session id. Omit when only one session is open." };
const tabId = { type: "string", description: "Tab id. Omit for the active tab." };

/** The agent-facing tool surface. Both the local MCP server and the hosted MCP
 *  worker render this list, so names and descriptions cannot drift apart. */
export const AGENT_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = [
  {
    name: "browser_session",
    description: "Open, close or inspect a browser session. Reuse one session per task and close it when done.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["open", "close", "list", "state"] },
        sessionId,
        idleMinutes: {
          type: "number",
          minimum: 1,
          maximum: 30,
          description:
            "Close the browser after this long with no action. Defaults to the router's own idle setting. Hosted servers cap this lower and reject anything above their cap.",
        },
        pageConsole: { type: "boolean", description: "Also capture the page's own console output." },
      },
      required: ["action"],
    },
  },
  {
    name: "browser_navigate",
    description: "Go to a url and return the page's interactive elements.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, sessionId, tabId },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description: "List what you can click or type on the page, labelled e1, e2. Labels change after every navigation.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["viewport", "full"] },
        interactiveOnly: { type: "boolean" },
        maxLines: { type: "number" },
        sinceLast: { type: "boolean", description: "Return 'unchanged' when the page has not moved." },
        sessionId,
        tabId,
      },
    },
  },
  {
    name: "browser_act",
    description:
      "Run one or more steps (click, fill, type, press, hover, check, uncheck, select, scroll, wait) and return only what changed.",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["click", "fill", "type", "press", "hover", "check", "uncheck", "select", "scroll", "wait"],
              },
              ref: { type: "string", description: "Element label from a snapshot, e.g. e4" },
              text: { type: "string", description: "Text to fill or type, or the option label for select" },
              key: { type: "string", description: "Key name for press, e.g. Enter" },
              direction: { type: "string", enum: ["up", "down"] },
              amount: { type: "number" },
              ms: { type: "number", description: "Pause in milliseconds for a wait step, max 10000" },
            },
            required: ["type"],
          },
        },
        stopOnError: { type: "boolean" },
        settleMs: { type: "number" },
        sessionId,
        tabId,
      },
      required: ["steps"],
    },
  },
  {
    name: "browser_extract",
    description: "Read the page as markdown, plain text or a link list. Cheaper than a screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["markdown", "text", "links"] },
        selector: { type: "string" },
        maxChars: { type: "number" },
        sessionId,
        tabId,
      },
    },
  },
  {
    name: "browser_screenshot",
    description: "Take a jpeg screenshot. Use only when you must see layout.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Screenshot one element instead of the page." },
        fullPage: { type: "boolean" },
        quality: { type: "number", minimum: 1, maximum: 100 },
        skipIfUnchanged: { type: "boolean" },
        sessionId,
        tabId,
      },
    },
  },
  {
    name: "browser_wait",
    description: "Wait for text or an element to appear or disappear, or for the url to change.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        textGone: { type: "string" },
        selector: { type: "string" },
        selectorGone: { type: "string" },
        urlContains: { type: "string" },
        timeoutMs: { type: "number" },
        sessionId,
        tabId,
      },
    },
  },
  {
    name: "browser_tabs",
    description: "List, open, switch or close tabs in this session.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "new", "select", "close"] },
        tabId,
        url: { type: "string" },
        sessionId,
      },
      required: ["action"],
    },
  },
  {
    name: "browser_evaluate",
    description: "Run a JavaScript expression in the page and return its value.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string" }, sessionId, tabId },
      required: ["expression"],
    },
  },
  {
    name: "browser_observe",
    description: "Console output, failed requests, downloads, dialogs and popup tabs seen in this session.",
    inputSchema: { type: "object", properties: { sessionId } },
  },
] as const;

export const AGENT_TOOL_NAMES = AGENT_TOOL_DEFINITIONS.map((t) => t.name);

/** Renders the tool list with a server-specific ceiling on `idleMinutes`, so an
 *  agent reads the real limit instead of discovering it through an error. */
export function agentToolDefinitions(opts: { maxIdleMinutes?: number } = {}): AgentToolDefinition[] {
  const max = opts.maxIdleMinutes;
  if (max === undefined) return [...AGENT_TOOL_DEFINITIONS];
  return AGENT_TOOL_DEFINITIONS.map((tool) => {
    if (tool.name !== "browser_session") return tool;
    const idle = tool.inputSchema.properties["idleMinutes"] as Record<string, unknown>;
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...tool.inputSchema.properties,
          idleMinutes: {
            ...idle,
            maximum: max,
            description: `Close the browser after this long with no action. Maximum ${max} minutes on this server; longer requests are rejected.`,
          },
        },
      },
    };
  });
}

export function agentToolDefinition(name: string): AgentToolDefinition | undefined {
  return AGENT_TOOL_DEFINITIONS.find((t) => t.name === name);
}
