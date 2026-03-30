import { z } from "zod";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Gateway } from "../../core/index.js";
import type { Logger } from "pino";
import type { McpSessionManager, McpBrowserSession } from "./sessions.js";
import { getSnapshot, clickByRef, typeByRef } from "./ax-tree.js";

function text(data: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
    }],
  };
}

function err(msg: string) {
  return {
    content: [{ type: "text" as const, text: msg }],
    isError: true as const,
  };
}

export function registerTools(
  server: McpServer,
  gateway: Gateway,
  sessionManager: McpSessionManager,
  logger: Logger,
): void {

  async function getOrCreateSession(sessionId?: string): Promise<McpBrowserSession | null> {
    if (sessionId) {
      return sessionManager.getSession(sessionId) ?? null;
    }
    return sessionManager.getFirstSession() ?? sessionManager.createSession();
  }

  server.registerTool("browser_navigate", {
    title: "Navigate to URL",
    description:
      "Navigate the browser to a URL. A browser session is automatically created if none exists. " +
      "After navigation, use browser_snapshot to see the page content.",
    inputSchema: z.object({
      url: z.string().describe("The URL to navigate to"),
      sessionId: z.string().optional().describe("Session ID (auto-created if not provided)"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ url, sessionId }) => {
    const session = await getOrCreateSession(sessionId);
    if (!session) return err("Failed to create browser session - all providers unavailable.");

    try {
      const result = await session.cdp.navigate(url);
      return text({
        sessionId: session.sessionId,
        url: result.url,
        title: result.title,
        status: "loaded",
      });
    } catch (e) {
      return err(`Navigation error: ${(e as Error).message}`);
    }
  });

  server.registerTool("browser_snapshot", {
    title: "Get Page Snapshot",
    description:
      "Get an accessibility snapshot of the current page. Returns numbered refs like [1], [2] " +
      "that can be passed to browser_interact as selectors. " +
      "Use this to understand page structure and find elements to interact with.",
    inputSchema: z.object({
      sessionId: z.string().optional().describe("Session ID"),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ sessionId }) => {
    const session = await getOrCreateSession(sessionId);
    if (!session) return err("No active session. Call browser_navigate first.");

    try {
      const snapshot = await getSnapshot(session.cdp);
      return text(`Page snapshot (use [n] refs with browser_interact):\n\n${snapshot}`);
    } catch (e) {
      return err(`Snapshot failed: ${(e as Error).message}`);
    }
  });

  server.registerTool("browser_screenshot", {
    title: "Take Screenshot",
    description:
      "Capture a screenshot of the current page. Returns a PNG image. " +
      "Use browser_snapshot instead for most tasks - screenshots are for visual verification only.",
    inputSchema: z.object({
      sessionId: z.string().optional().describe("Session ID"),
      fullPage: z.boolean().optional().describe("Capture full scrollable page (default: false)"),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ sessionId, fullPage }) => {
    const session = await getOrCreateSession(sessionId);
    if (!session) return err("No active session. Call browser_navigate first.");

    try {
      const data = await session.cdp.screenshot(fullPage ?? false);

      const filename = `screenshot-${Date.now()}.png`;
      const filepath = join(tmpdir(), filename);
      writeFileSync(filepath, Buffer.from(data, "base64"));

      return {
        content: [
          {
            type: "image" as const,
            data,
            mimeType: "image/png",
          },
          {
            type: "text" as const,
            text: `Screenshot saved to: ${filepath}`,
          },
        ],
      };
    } catch (e) {
      return err(`Screenshot failed: ${(e as Error).message}`);
    }
  });

  server.registerTool("browser_set_viewport", {
    title: "Set Viewport Size",
    description:
      "Set the browser viewport dimensions. Use this before taking screenshots to control the page layout " +
      "(e.g., desktop 1920x1080, tablet 768x1024, mobile 375x667).",
    inputSchema: z.object({
      width: z.number().describe("Viewport width in pixels"),
      height: z.number().describe("Viewport height in pixels"),
      deviceScaleFactor: z.number().optional().describe("Device scale factor (default: 1, retina: 2)"),
      mobile: z.boolean().optional().describe("Emulate mobile device (default: false)"),
      sessionId: z.string().optional().describe("Session ID"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ width, height, deviceScaleFactor, mobile, sessionId }) => {
    const session = await getOrCreateSession(sessionId);
    if (!session) return err("No active session. Call browser_navigate first.");

    try {
      await session.cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: deviceScaleFactor ?? 1,
        mobile: mobile ?? false,
      });

      return text({
        sessionId: session.sessionId,
        viewport: { width, height, deviceScaleFactor: deviceScaleFactor ?? 1, mobile: mobile ?? false },
      });
    } catch (e) {
      return err(`Set viewport failed: ${(e as Error).message}`);
    }
  });

  server.registerTool("browser_interact", {
    title: "Interact with Page",
    description:
      "Perform an action on the page: click, type, select, press key, or scroll. " +
      "Use [n] refs from browser_snapshot as selectors, or CSS selectors.",
    inputSchema: z.object({
      action: z.enum(["click", "type", "select", "press", "scroll"]).describe("The action to perform"),
      selector: z.string().optional().describe("Element ref like [1] from snapshot, or CSS selector"),
      text: z.string().optional().describe("Text to type (for 'type' action)"),
      key: z.string().optional().describe("Key to press (for 'press' action): Enter, Tab, Escape, etc."),
      direction: z.enum(["up", "down"]).optional().describe("Scroll direction (for 'scroll' action)"),
      clear: z.boolean().optional().describe("Clear existing text before typing (default: true)"),
      sessionId: z.string().optional().describe("Session ID"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ action, selector, text: inputText, key, direction, clear, sessionId }) => {
    const session = await getOrCreateSession(sessionId);
    if (!session) return err("No active session. Call browser_navigate first.");

    try {
      const refMatch = selector?.match(/^\[?(\d+)\]?$/);
      const ref = refMatch ? parseInt(refMatch[1], 10) : null;

      if (action === "click") {
        if (!selector) return err("'selector' is required for click action.");

        if (ref) {
          const result = await clickByRef(session.cdp, ref);
          if (!result.success) return err(result.error!);
          return text({ sessionId: session.sessionId, action: "click", ref, status: "clicked" });
        }

        const result = await session.cdp.evaluate(`
          (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return { error: 'Element not found: ' + ${JSON.stringify(selector)} };
            el.scrollIntoView({ block: 'center' });
            el.click();
            return { success: true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80) };
          })()
        `) as { error?: string; success?: boolean; tag?: string; text?: string };

        if (result.error) return err(result.error);
        return text({ sessionId: session.sessionId, action: "click", selector, element: result.tag });
      }

      if (action === "type") {
        if (!selector) return err("'selector' is required for type action.");
        if (inputText === undefined) return err("'text' is required for type action.");

        if (ref) {
          const result = await typeByRef(session.cdp, ref, inputText, clear !== false);
          if (!result.success) return err(result.error!);
          return text({ sessionId: session.sessionId, action: "type", ref, typed: inputText });
        }

        await session.cdp.evaluate(`
          (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
            el.focus();
            const nativeSetter = Object.getOwnPropertyDescriptor(
              Object.getPrototypeOf(el).constructor.prototype, 'value'
            )?.set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            const newValue = ${clear !== false} ? ${JSON.stringify(inputText)} : el.value + ${JSON.stringify(inputText)};
            if (nativeSetter) nativeSetter.call(el, newValue);
            else el.value = newValue;
            const reactProps = Object.keys(el).find(k => k.startsWith('__reactProps$'));
            if (reactProps && el[reactProps]?.onChange) {
              el[reactProps].onChange({ target: el, currentTarget: el });
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          })()
        `);

        return text({ sessionId: session.sessionId, action: "type", selector, typed: inputText });
      }

      if (action === "select") {
        if (!selector) return err("'selector' is required for select action.");
        if (inputText === undefined) return err("'text' is required for select action (the option value).");

        await session.cdp.evaluate(`
          (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
            el.value = ${JSON.stringify(inputText)};
            el.dispatchEvent(new Event('change', { bubbles: true }));
          })()
        `);

        return text({ sessionId: session.sessionId, action: "select", selector, selected: inputText });
      }

      if (action === "press") {
        const keyName = key ?? "Enter";
        const keyMap: Record<string, { code: string; keyCode: number }> = {
          Enter: { code: "Enter", keyCode: 13 },
          Tab: { code: "Tab", keyCode: 9 },
          Escape: { code: "Escape", keyCode: 27 },
          Backspace: { code: "Backspace", keyCode: 8 },
          Delete: { code: "Delete", keyCode: 46 },
          ArrowUp: { code: "ArrowUp", keyCode: 38 },
          ArrowDown: { code: "ArrowDown", keyCode: 40 },
          ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
          ArrowRight: { code: "ArrowRight", keyCode: 39 },
          Space: { code: "Space", keyCode: 32 },
        };

        const keyInfo = keyMap[keyName] ?? { code: keyName, keyCode: 0 };

        await session.cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: keyName,
          code: keyInfo.code,
          windowsVirtualKeyCode: keyInfo.keyCode,
          nativeVirtualKeyCode: keyInfo.keyCode,
        });
        await session.cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: keyName,
          code: keyInfo.code,
          windowsVirtualKeyCode: keyInfo.keyCode,
          nativeVirtualKeyCode: keyInfo.keyCode,
        });

        return text({ sessionId: session.sessionId, action: "press", key: keyName });
      }

      if (action === "scroll") {
        const amount = direction === "up" ? -500 : 500;
        await session.cdp.evaluate(`window.scrollBy(0, ${amount})`);
        return text({ sessionId: session.sessionId, action: "scroll", direction: direction ?? "down" });
      }

      return err(`Unknown action: ${action}`);
    } catch (e) {
      return err(`Interact failed: ${(e as Error).message}`);
    }
  });

  server.registerTool("browser_evaluate", {
    title: "Evaluate JavaScript",
    description:
      "Execute JavaScript code in the browser page. Use for any operation not covered by other tools. " +
      "Scripts with 'await' are automatically wrapped in an async function.",
    inputSchema: z.object({
      expression: z.string().describe("JavaScript code to evaluate in the page"),
      sessionId: z.string().optional().describe("Session ID"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ expression, sessionId }) => {
    const session = await getOrCreateSession(sessionId);
    if (!session) return err("No active session. Call browser_navigate first.");

    try {
      const result = await session.cdp.evaluate(expression);
      return text({ sessionId: session.sessionId, result });
    } catch (e) {
      return err((e as Error).message);
    }
  });

  server.registerTool("browser_close", {
    title: "Close Browser Session",
    description: "Close the browser session and free the slot for other agents.",
    inputSchema: z.object({
      sessionId: z.string().optional().describe("Session ID to close (closes first session if not specified)"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ sessionId }) => {
    const targetId = sessionId ?? sessionManager.getFirstSession()?.sessionId;
    if (!targetId) return err("No active session to close.");

    const result = sessionManager.releaseSession(targetId);
    if (!result.success) return err(`Session not found: ${targetId}`);
    return text({ success: true, durationMs: result.durationMs });
  });

  server.registerTool("browser_status", {
    title: "Get Gateway Status",
    description: "Get gateway status: provider health, active sessions, queue state.",
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async () => {
    const status = gateway.getStatus();
    return text({
      providers: status.providers.map((p) => ({
        id: p.id,
        healthy: p.healthy,
        active: p.active,
        maxConcurrent: p.config.limits?.maxConcurrent,
      })),
      activeSessions: status.activeSessions,
      mcpSessions: sessionManager.count(),
      queueSize: status.queueSize,
    });
  });
}
