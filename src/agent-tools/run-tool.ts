import type { ActionStep } from "./actions.js";
import { fetchPage, screenshotPage } from "./one-shot.js";
import type { ExtractFormat } from "./read.js";
import type { AgentSession, WindowSizeResult } from "./session.js";

type Args = Record<string, unknown>;

const str = (args: Args, key: string): string | undefined =>
  typeof args[key] === "string" ? (args[key] as string) : undefined;
const num = (args: Args, key: string): number | undefined =>
  typeof args[key] === "number" ? (args[key] as number) : undefined;
const bool = (args: Args, key: string): boolean | undefined =>
  typeof args[key] === "boolean" ? (args[key] as boolean) : undefined;
const imageFormat = (args: Args): "jpeg" | "png" | undefined =>
  args["format"] === "png" ? "png" : args["format"] === "jpeg" ? "jpeg" : undefined;
const extractFormat = (args: Args): ExtractFormat | undefined => {
  const value = str(args, "format");
  return value === "markdown" || value === "text" || value === "links" ? value : undefined;
};

/** The window size a `browser_session open` call asked for, or null when it asked for none. */
export function requestedWindowSize(args: Args): { width: number; height: number } | null {
  const width = num(args, "width");
  const height = num(args, "height");
  if (width === undefined && height === undefined) return null;
  if (width === undefined || height === undefined) throw new Error("give both width and height for the window size");
  return { width, height };
}

/** Applies the window size an open call asked for and reports what the page got. */
export async function applyOpenOptions(session: AgentSession, args: Args): Promise<{ window?: WindowSizeResult }> {
  const size = requestedWindowSize(args);
  if (!size) return {};
  return { window: await session.resizeWindow(size) };
}

/** The source to run: a saved script by name, or the expression given (saved first when `saveAs` is set). */
function scriptSource(session: AgentSession, args: Args, expressionKey: string): string | undefined {
  const name = str(args, "script");
  if (name) return session.savedScript(name);
  const expression = str(args, expressionKey);
  const saveAs = str(args, "saveAs");
  if (expression && saveAs) session.saveScript(saveAs, expression);
  return expression;
}

/** Executes one session-scoped agent tool. Opening, closing and listing
 *  sessions stays with each server, which owns providers and billing. */
export async function runAgentTool(session: AgentSession, name: string, args: Args): Promise<unknown> {
  const tabId = str(args, "tabId");

  switch (name) {
    case "fetch_page": {
      const url = str(args, "url");
      if (!url) throw new Error("fetch_page needs a url");
      return fetchPage(session, {
        url,
        format: extractFormat(args),
        selector: str(args, "selector"),
        maxChars: num(args, "maxChars"),
        waitForText: str(args, "waitForText"),
      });
    }

    case "screenshot_page": {
      const url = str(args, "url");
      if (!url) throw new Error("screenshot_page needs a url");
      return screenshotPage(session, {
        url,
        fullPage: bool(args, "fullPage"),
        quality: num(args, "quality"),
        format: imageFormat(args),
        waitForText: str(args, "waitForText"),
      });
    }

    case "browser_navigate": {
      const url = str(args, "url");
      if (!url) throw new Error("browser_navigate needs a url");
      const source = scriptSource(session, args, "evaluate");
      const wantSnapshot = bool(args, "snapshot") !== false;
      if (wantSnapshot) {
        const result = await session.navigate(url, tabId);
        return {
          url: result.url,
          title: result.title,
          tabId: result.tabId,
          snapshot: result.snapshot.text,
          ...(source ? { value: await session.evaluate(source, result.tabId) } : {}),
          session: result.session,
          warning: result.warning,
        };
      }
      const loaded = await session.goto(url, tabId);
      return {
        url: loaded.url,
        title: loaded.title,
        tabId: loaded.tabId,
        ...(source ? { value: await session.evaluate(source, loaded.tabId) } : {}),
        session: session.state,
      };
    }

    case "browser_snapshot": {
      const snap = await session.snapshot(
        {
          scope: str(args, "scope") === "full" ? "full" : "viewport",
          interactiveOnly: bool(args, "interactiveOnly") ?? true,
          maxLines: num(args, "maxLines"),
          sinceLast: bool(args, "sinceLast"),
        },
        tabId,
      );
      return { snapshot: snap.text, truncated: snap.truncated, unchanged: snap.unchanged };
    }

    case "browser_act": {
      const steps = Array.isArray(args["steps"]) ? (args["steps"] as ActionStep[]) : [];
      if (steps.length === 0) throw new Error("browser_act needs at least one step");
      return session.act(steps, { tabId, stopOnError: bool(args, "stopOnError"), settleMs: num(args, "settleMs") });
    }

    case "browser_extract":
      return session.extract(
        { format: extractFormat(args) ?? "markdown", selector: str(args, "selector"), maxChars: num(args, "maxChars") },
        tabId,
      );

    case "browser_screenshot":
      return session.screenshot(
        {
          ref: str(args, "ref"),
          fullPage: bool(args, "fullPage"),
          quality: num(args, "quality"),
          skipIfUnchanged: bool(args, "skipIfUnchanged"),
          format: imageFormat(args),
        },
        tabId,
      );

    case "browser_wait":
      return session.waitFor(
        {
          text: str(args, "text"),
          textGone: str(args, "textGone"),
          selector: str(args, "selector"),
          selectorGone: str(args, "selectorGone"),
          urlContains: str(args, "urlContains"),
          timeoutMs: num(args, "timeoutMs"),
        },
        tabId,
      );

    case "browser_tabs": {
      const action = str(args, "action") ?? "list";
      if (action === "new") {
        const tab = await session.openTab(str(args, "url") ?? "about:blank");
        return { tabId: tab.tabId, url: tab.url, tabs: session.tabIds };
      }
      if (action === "select") {
        if (!tabId) throw new Error("browser_tabs select needs a tabId");
        const tab = session.selectTab(tabId);
        return { tabId: tab.tabId, url: tab.url };
      }
      if (action === "close") {
        if (!tabId) throw new Error("browser_tabs close needs a tabId");
        await session.closeTab(tabId);
        return { closed: tabId, tabs: session.tabIds };
      }
      return { tabs: session.tabIds, active: session.activeTab?.tabId ?? null };
    }

    case "browser_evaluate": {
      const source = scriptSource(session, args, "expression");
      if (!source) throw new Error("browser_evaluate needs an expression, or script with the name of a saved one");
      const saved = str(args, "saveAs");
      return { value: await session.evaluate(source, tabId), ...(saved && str(args, "expression") ? { saved } : {}) };
    }

    case "browser_observe":
      return session.observed();

    default:
      throw new Error(`unknown tool ${name}`);
  }
}
