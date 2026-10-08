export interface AgentToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  openWorldHint: boolean;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  annotations: AgentToolAnnotations;
  /** Ask clients that load tools on demand to load this one up front. */
  alwaysLoad?: boolean;
}

const sessionId = { type: "string", description: "Session id. Omit when only one session is open." };
const tabId = { type: "string", description: "Tab id. Omit for the active tab." };
const pageUrl = { type: "string", description: "Full url, including https://" };
const waitForText = {
  type: "string",
  description: "Wait for this text to appear before reading, for pages that load their content late.",
};
const reads = (title: string): AgentToolAnnotations => ({ title, readOnlyHint: true, openWorldHint: true });
const acts = (title: string): AgentToolAnnotations => ({ title, readOnlyHint: false, openWorldHint: true });

/** The agent-facing tool surface. Both the local MCP server and the hosted MCP
 *  worker render this list, so names and descriptions cannot drift apart. */
export const AGENT_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = [
  {
    name: "fetch_page",
    description:
      "Read a web page with a real browser and get clean markdown, in one call. Use when a built-in web fetch failed (403, 402, 429, captcha, empty or JavaScript-only page) or the page needs JavaScript or a saved login. For ordinary static pages, try the built-in web fetch first. Opens a browser, loads the page, reads it and closes it. Returns `blocked` when the page looks like a bot check, error or login wall.",
    inputSchema: {
      type: "object",
      properties: {
        url: pageUrl,
        format: { type: "string", enum: ["markdown", "text", "links"], description: "Default markdown." },
        selector: { type: "string", description: "Read only the part of the page inside this CSS selector." },
        maxChars: { type: "number", description: "Default 20000." },
        waitForText,
      },
      required: ["url"],
    },
    annotations: reads("Fetch page (real browser)"),
  },
  {
    name: "screenshot_page",
    description:
      'Take a screenshot of a website or web page with a real browser, in one call. Give a url, get the image. Use for "take a screenshot of", "what does this site look like" or checking a layout, including JavaScript-heavy pages. Opens a browser, loads the page, captures it and closes it. For several steps on one site, use browser_session instead.',
    inputSchema: {
      type: "object",
      properties: {
        url: pageUrl,
        fullPage: { type: "boolean", description: "Capture the whole page, not just the first screen." },
        quality: { type: "number", minimum: 1, maximum: 100 },
        waitForText,
      },
      required: ["url"],
    },
    annotations: reads("Screenshot page (real browser)"),
    alwaysLoad: true,
  },
  {
    name: "browser_session",
    description:
      "Start a real browser for multi-step work on a website: logging in, filling forms, clicking through pages, reading several pages. For a single page read or screenshot, use fetch_page or screenshot_page instead. One browser per task; it closes after a few idle minutes, so close it yourself when done.",
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
    annotations: acts("Browser session"),
  },
  {
    name: "browser_navigate",
    description:
      "Go to a url in the open browser session and list the page's clickable and typeable elements, labelled e1, e2.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, sessionId, tabId },
      required: ["url"],
    },
    annotations: acts("Go to url"),
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
    annotations: reads("Page elements"),
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
    annotations: acts("Act on page"),
  },
  {
    name: "browser_extract",
    description:
      "Read the current page in the open browser as markdown, plain text or a link list. Much cheaper than a screenshot. To read a url without opening a session, use fetch_page.",
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
    annotations: reads("Read current page"),
  },
  {
    name: "browser_screenshot",
    description:
      "Screenshot the current page in the open browser, or one element by its label. To screenshot a url without opening a session, use screenshot_page.",
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
    annotations: reads("Screenshot current page"),
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
    annotations: reads("Wait for page"),
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
    annotations: acts("Tabs"),
  },
  {
    name: "browser_evaluate",
    description: "Run a JavaScript expression in the page and return its value.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string" }, sessionId, tabId },
      required: ["expression"],
    },
    annotations: acts("Run JavaScript"),
  },
  {
    name: "browser_observe",
    description: "Console output, failed requests, downloads, dialogs and popup tabs seen in this session.",
    inputSchema: { type: "object", properties: { sessionId } },
    annotations: reads("Session events"),
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
