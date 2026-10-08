import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Logger } from "pino";
import type { Gateway } from "../../core/index.js";
import {
  agentToolDefinition,
  fetchPage,
  screenshotPage,
  type ActionStep,
  type ActionType,
  type AgentToolDefinition,
} from "../../agent-tools/index.js";
import type { McpBrowserSession, McpSessionManager } from "./sessions.js";

const ACTION_TYPES = [
  "click",
  "fill",
  "type",
  "press",
  "hover",
  "check",
  "uncheck",
  "select",
  "scroll",
] as const satisfies readonly ActionType[];

const stepSchema = z.object({
  type: z.enum(ACTION_TYPES),
  ref: z.string().optional().describe("Element label from a snapshot, e.g. e4"),
  text: z.string().optional().describe("Text to fill or type, or the option label for select"),
  key: z.string().optional().describe("Key name for press, e.g. Enter"),
  direction: z.enum(["up", "down"]).optional(),
  amount: z.number().optional(),
});

const sessionIdArg = z.string().optional().describe("Session id. Omit when only one session is open.");
const tabIdArg = z.string().optional().describe("Tab id. Omit for the active tab.");

function text(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}

function failed(err: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
}

function definition(name: string): AgentToolDefinition {
  const def = agentToolDefinition(name);
  if (!def) throw new Error(`no shared definition for tool ${name}`);
  return def;
}

function describeTool(name: string): string {
  return definition(name).description;
}

function annotate(name: string): AgentToolDefinition["annotations"] {
  return definition(name).annotations;
}

function toolConfig(name: string) {
  const def = definition(name);
  return {
    title: def.annotations.title,
    description: def.description,
    annotations: def.annotations,
    ...(def.alwaysLoad ? { _meta: { "anthropic/alwaysLoad": true } } : {}),
  };
}

function sessionSummary(session: McpBrowserSession): Record<string, unknown> {
  const state = session.agent.state;
  return {
    sessionId: session.sessionId,
    provider: session.providerId,
    tabs: session.agent.tabIds,
    idleTimeoutS: state.idleTimeoutS,
    secondsUntilIdleClose: state.secondsUntilIdleClose,
  };
}

export function registerTools(
  mcp: McpServer,
  gateway: Gateway,
  sessions: McpSessionManager,
  logger: Logger,
): void {
  const use = async <T>(
    sessionId: string | undefined,
    run: (session: McpBrowserSession) => Promise<T>,
  ): Promise<ReturnType<typeof text>> => {
    await sessions.reapExpired();
    try {
      const session = sessions.resolve(sessionId);
      const result = await run(session);
      return text(result);
    } catch (err) {
      logger.warn({ sessionId, error: (err as Error).message }, "mcp tool failed");
      return failed(err) as ReturnType<typeof text>;
    }
  };

  const oneShot = async <T>(run: (session: McpBrowserSession) => Promise<T>): Promise<T> => {
    await sessions.reapExpired();
    const session = await sessions.createSession();
    if (!session) throw new Error("no provider available right now. Try again shortly.");
    try {
      return await run(session);
    } finally {
      await sessions.releaseSession(session.sessionId);
    }
  };

  mcp.registerTool(
    "fetch_page",
    {
      ...toolConfig("fetch_page"),
      inputSchema: {
        url: z.string().url(),
        format: z.enum(["markdown", "text", "links"]).optional(),
        selector: z.string().optional(),
        maxChars: z.number().optional(),
        waitForText: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return text(await oneShot((session) => fetchPage(session.agent, args)));
      } catch (err) {
        logger.warn({ tool: "fetch_page", error: (err as Error).message }, "mcp tool failed");
        return failed(err);
      }
    },
  );

  mcp.registerTool(
    "screenshot_page",
    {
      ...toolConfig("screenshot_page"),
      inputSchema: {
        url: z.string().url(),
        fullPage: z.boolean().optional(),
        quality: z.number().min(1).max(100).optional(),
        waitForText: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const shot = await oneShot((session) => screenshotPage(session.agent, args));
        const { image, ...page } = shot;
        return {
          content: [
            { type: "image" as const, data: image.base64 ?? "", mimeType: `image/${image.format}` },
            { type: "text" as const, text: JSON.stringify(page) },
          ],
        };
      } catch (err) {
        logger.warn({ tool: "screenshot_page", error: (err as Error).message }, "mcp tool failed");
        return failed(err);
      }
    },
  );

  mcp.tool(
    "browser_session",
    describeTool("browser_session"),
    {
      action: z.enum(["open", "close", "list", "state"]),
      sessionId: sessionIdArg,
      idleMinutes: z.number().min(1).max(30).optional().describe("Close after this long with no action. Default 5."),
      pageConsole: z.boolean().optional().describe("Also capture the page's own console output."),
    },
    annotate("browser_session"),
    async ({ action, sessionId, idleMinutes, pageConsole }) => {
      await sessions.reapExpired();
      if (action === "open") {
        const created = await sessions.createSession({
          idleMs: idleMinutes === undefined ? undefined : idleMinutes * 60_000,
          pageConsole,
        });
        if (!created) return failed(new Error("no provider available right now. Try again shortly."));
        return text({ ...sessionSummary(created), opened: true });
      }
      if (action === "close") {
        try {
          const target = sessions.resolve(sessionId);
          const released = await sessions.releaseSession(target.sessionId);
          return text({ closed: released.success, sessionId: target.sessionId, durationMs: released.durationMs });
        } catch (err) {
          return failed(err);
        }
      }
      if (action === "list") return text({ sessions: sessions.getAll().map(sessionSummary) });
      return use(sessionId, async (session) => sessionSummary(session));
    },
  );

  mcp.tool(
    "browser_navigate",
    describeTool("browser_navigate"),
    { url: z.string().url(), sessionId: sessionIdArg, tabId: tabIdArg },
    annotate("browser_navigate"),
    async ({ url, sessionId, tabId }) =>
      use(sessionId, async (session) => {
        const result = await session.agent.navigate(url, tabId);
        return {
          url: result.url,
          title: result.title,
          tabId: result.tabId,
          snapshot: result.snapshot.text,
          session: result.session,
          warning: result.warning,
        };
      }),
  );

  mcp.tool(
    "browser_snapshot",
    describeTool("browser_snapshot"),
    {
      scope: z.enum(["viewport", "full"]).optional(),
      interactiveOnly: z.boolean().optional(),
      maxLines: z.number().optional(),
      sinceLast: z.boolean().optional().describe("Return 'unchanged' when the page has not moved."),
      sessionId: sessionIdArg,
      tabId: tabIdArg,
    },
    annotate("browser_snapshot"),
    async ({ sessionId, tabId, ...opts }) =>
      use(sessionId, async (session) => {
        const snap = await session.agent.snapshot(opts, tabId);
        return { snapshot: snap.text, truncated: snap.truncated, unchanged: snap.unchanged };
      }),
  );

  mcp.tool(
    "browser_act",
    describeTool("browser_act"),
    {
      steps: z.array(stepSchema).min(1),
      stopOnError: z.boolean().optional(),
      settleMs: z.number().optional(),
      sessionId: sessionIdArg,
      tabId: tabIdArg,
    },
    annotate("browser_act"),
    async ({ steps, stopOnError, settleMs, sessionId, tabId }) =>
      use(sessionId, async (session) =>
        session.agent.act(steps as ActionStep[], { stopOnError, settleMs, tabId }),
      ),
  );

  mcp.tool(
    "browser_extract",
    describeTool("browser_extract"),
    {
      format: z.enum(["markdown", "text", "links"]).optional(),
      selector: z.string().optional(),
      maxChars: z.number().optional(),
      sessionId: sessionIdArg,
      tabId: tabIdArg,
    },
    annotate("browser_extract"),
    async ({ sessionId, tabId, ...opts }) =>
      use(sessionId, async (session) => session.agent.extract(opts, tabId)),
  );

  mcp.tool(
    "browser_screenshot",
    describeTool("browser_screenshot"),
    {
      ref: z.string().optional().describe("Screenshot one element instead of the page."),
      fullPage: z.boolean().optional(),
      quality: z.number().min(1).max(100).optional(),
      skipIfUnchanged: z.boolean().optional(),
      sessionId: sessionIdArg,
      tabId: tabIdArg,
    },
    annotate("browser_screenshot"),
    async ({ sessionId, tabId, ...opts }) => {
      await sessions.reapExpired();
      try {
        const session = sessions.resolve(sessionId);
        const shot = await session.agent.screenshot(opts, tabId);
        if (shot.unchanged || !shot.base64) return text({ unchanged: true });
        return {
          content: [{ type: "image" as const, data: shot.base64, mimeType: "image/jpeg" }],
        };
      } catch (err) {
        return failed(err);
      }
    },
  );

  mcp.tool(
    "browser_wait",
    describeTool("browser_wait"),
    {
      text: z.string().optional(),
      textGone: z.string().optional(),
      selector: z.string().optional(),
      selectorGone: z.string().optional(),
      urlContains: z.string().optional(),
      timeoutMs: z.number().optional(),
      sessionId: sessionIdArg,
      tabId: tabIdArg,
    },
    annotate("browser_wait"),
    async ({ sessionId, tabId, ...condition }) =>
      use(sessionId, async (session) => session.agent.waitFor(condition, tabId)),
  );

  mcp.tool(
    "browser_tabs",
    describeTool("browser_tabs"),
    {
      action: z.enum(["list", "new", "select", "close"]),
      tabId: tabIdArg,
      url: z.string().url().optional(),
      sessionId: sessionIdArg,
    },
    annotate("browser_tabs"),
    async ({ action, tabId, url, sessionId }) =>
      use(sessionId, async (session) => {
        if (action === "new") {
          const tab = await session.agent.openTab(url ?? "about:blank");
          return { tabId: tab.tabId, url: tab.url, tabs: session.agent.tabIds };
        }
        if (action === "select") {
          if (!tabId) throw new Error("select needs a tabId");
          const tab = session.agent.selectTab(tabId);
          return { tabId: tab.tabId, url: tab.url };
        }
        if (action === "close") {
          if (!tabId) throw new Error("close needs a tabId");
          await session.agent.closeTab(tabId);
          return { closed: tabId, tabs: session.agent.tabIds };
        }
        return { tabs: session.agent.tabIds, active: session.agent.activeTab?.tabId ?? null };
      }),
  );

  mcp.tool(
    "browser_evaluate",
    describeTool("browser_evaluate"),
    { expression: z.string(), sessionId: sessionIdArg, tabId: tabIdArg },
    annotate("browser_evaluate"),
    async ({ expression, sessionId, tabId }) =>
      use(sessionId, async (session) => ({ value: await session.agent.evaluate(expression, tabId) })),
  );

  mcp.tool(
    "browser_observe",
    describeTool("browser_observe"),
    { sessionId: sessionIdArg },
    annotate("browser_observe"),
    async ({ sessionId }) => use(sessionId, async (session) => session.agent.observed()),
  );

  mcp.tool("browser_status", "Gateway providers, sessions and queue state.", {}, async () => {
    const status = gateway.getStatus();
    return text({
      providers: status.providers.map((p) => ({
        id: p.id,
        healthy: p.healthy,
        active: p.active,
        maxConcurrent: p.config.limits?.maxConcurrent ?? p.discoveredMaxConcurrent ?? null,
      })),
      mcpSessions: sessions.count(),
      queueSize: status.queueSize,
    });
  });
}
