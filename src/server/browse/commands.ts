import type { AgentSession, ActionStep, ActionType } from "../../agent-tools/index.js";
import { flagNumber, normaliseRef, type BrowseRequest, type BrowseResponse } from "./protocol.js";

const ACTION_VERBS: Record<string, ActionType> = {
  click: "click",
  fill: "fill",
  type: "type",
  press: "press",
  check: "check",
  uncheck: "uncheck",
  select: "select",
  hover: "hover",
};

/** Runs one CLI verb against a live session. Text output stays terse so an agent
 *  pays for refs and diffs, not prose. */
export async function runBrowseCommand(session: AgentSession, req: BrowseRequest): Promise<BrowseResponse> {
  const { verb, args, flags } = req;
  const tabId = typeof flags.tab === "string" ? flags.tab : undefined;
  const ok = (text: string, data?: unknown): BrowseResponse => ({ id: req.id, ok: true, text, data });

  if (verb === "open") {
    const url = args[0];
    if (!url) throw new Error("open needs a url");
    const result = await session.navigate(url, tabId);
    return ok(
      [`${result.title} (${result.url})`, result.snapshot.text, result.warning ?? ""].filter(Boolean).join("\n"),
      result,
    );
  }

  if (verb === "snapshot") {
    const snap = await session.snapshot(
      {
        scope: flags.full === true ? "full" : "viewport",
        interactiveOnly: flags.all === true ? false : true,
        maxLines: flagNumber(flags, "max"),
        sinceLast: flags.changed === true,
      },
      tabId,
    );
    return ok(snap.text, snap);
  }

  const actionType = ACTION_VERBS[verb];
  if (actionType) {
    const ref = normaliseRef(args[0]);
    const value = args.slice(1).join(" ");
    const step: ActionStep = {
      type: actionType,
      ref,
      text: actionType === "press" ? undefined : value || undefined,
      key: actionType === "press" ? value || (typeof flags.key === "string" ? flags.key : "Enter") : undefined,
    };
    const result = await session.act([step], { tabId, settleMs: flagNumber(flags, "settle") });
    const lines = [result.changed.text];
    if (result.failedStep) lines.unshift(`failed: ${result.failedStep.error}`);
    if (result.warning) lines.push(result.warning);
    return { id: req.id, ok: result.ok, text: lines.join("\n"), data: result };
  }

  if (verb === "scroll") {
    const direction = args[0] === "up" ? "up" : "down";
    const result = await session.act(
      [{ type: "scroll", direction, amount: flagNumber(flags, "amount") }],
      { tabId, settleMs: flagNumber(flags, "settle") },
    );
    return { id: req.id, ok: result.ok, text: result.changed.text, data: result };
  }

  if (verb === "extract") {
    const format = typeof flags.format === "string" ? flags.format : "markdown";
    const result = await session.extract(
      {
        format: format as "markdown" | "text" | "links",
        selector: typeof flags.selector === "string" ? flags.selector : undefined,
        maxChars: flagNumber(flags, "max"),
      },
      tabId,
    );
    return ok(result.text, result);
  }

  if (verb === "screenshot") {
    const shot = await session.screenshot(
      {
        ref: normaliseRef(args[0]),
        fullPage: flags.full === true,
        quality: flagNumber(flags, "quality"),
        skipIfUnchanged: flags.changed === true,
      },
      tabId,
    );
    if (shot.unchanged) return ok("unchanged since the last screenshot", shot);
    return ok(`jpeg ${shot.bytes} bytes (base64 in --json output)`, shot);
  }

  if (verb === "wait") {
    const condition = {
      text: typeof flags.text === "string" ? flags.text : args[0],
      textGone: typeof flags.textGone === "string" ? flags.textGone : undefined,
      selector: typeof flags.selector === "string" ? flags.selector : undefined,
      selectorGone: typeof flags.selectorGone === "string" ? flags.selectorGone : undefined,
      urlContains: typeof flags.url === "string" ? flags.url : undefined,
      timeoutMs: flagNumber(flags, "timeout"),
    };
    const result = await session.waitFor(condition, tabId);
    return ok(`condition met after ${result.waitedMs}ms`, result);
  }

  if (verb === "tabs") {
    const action = args[0] ?? "list";
    if (action === "new") {
      const tab = await session.openTab(args[1] ?? "about:blank");
      return ok(`${tab.tabId} ${tab.url}`, { tabId: tab.tabId, tabs: session.tabIds });
    }
    if (action === "select") {
      const tab = session.selectTab(args[1] ?? "");
      return ok(`${tab.tabId} ${tab.url}`, { tabId: tab.tabId });
    }
    if (action === "close") {
      await session.closeTab(args[1] ?? "");
      return ok(session.tabIds.join(" ") || "no tabs left", { tabs: session.tabIds });
    }
    return ok(session.tabIds.map((id) => (id === session.activeTab?.tabId ? `${id} *` : id)).join("\n"), {
      tabs: session.tabIds,
    });
  }

  if (verb === "eval") {
    const value = await session.evaluate(args.join(" "), tabId);
    return ok(typeof value === "string" ? value : JSON.stringify(value), { value });
  }

  if (verb === "observe") {
    const seen = session.observed();
    const lines = [
      ...seen.console.map((c) => `console ${c.level}: ${c.text}`),
      ...seen.failedRequests.map((r) => `failed ${r.url}: ${r.errorText}`),
      ...seen.downloads.map((d) => `download ${d.fileName}`),
      ...seen.dialogs.map((d) => `dialog ${d.type} "${d.message}" -> ${d.handledWith}`),
      ...seen.newTabUrls.map((u) => `popup ${u}`),
    ];
    return ok(lines.join("\n") || "nothing recorded", seen);
  }

  throw new Error(`unknown verb ${verb}`);
}
