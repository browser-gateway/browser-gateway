import type { MouseButton } from "../input.js";
import type { ActionStep } from "../actions.js";
import type { TabInfo } from "../session.js";
import type { Point } from "../types.js";
import { checkUrl } from "./url-policy.js";
import { ComputerUseSession, type ComputerUseOptions } from "./session.js";
import {
  chordKeys,
  clampInt,
  clampSeconds,
  delay,
  errorResult as sharedError,
  imageBlock as image,
  MAX_HOLD_S,
  MemberError,
  messageOf,
  modifiersOf,
  okResult as sharedOk,
  requireString,
  runBatch,
  SCROLL_PX_PER_NOTCH,
  textBlock,
} from "./anthropic-shared.js";
import type {
  BrowserStateBlock,
  ImageBlock,
  StateChange,
  TabEntry,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";

const TOOLSET = "browser";
const TOOLSET_TYPE = "browser_toolset_20260801";
const HALT_TEXT = "Not executed: an earlier action in this turn failed.";
const PAGE_TEXT_MAX_CHARS = 50_000;
const LOG_LINE_MAX = 500;
const FIELD_MAX = 4096;
const TITLE_MAX = 300;
const TAB_MEMBERS = new Set(["new_tab", "list_tabs", "switch_tab", "close_tab"]);
const SECRET_PARAM = /token|key|secret|sig|auth|password|passwd|session|code|credential/i;

export interface AnthropicBrowserOptions extends ComputerUseOptions {
  /** Offer and run `read_console` and `read_network`. Default false. */
  logs?: boolean;
  /** Offer and run `javascript_exec`. Default false: page code runs with the page's cookies. */
  javascript?: boolean;
  /** Attach a screenshot to the last result of each turn. Default false. */
  attachScreenshot?: boolean;
}

type Target = { type: "coordinate"; x: number; y: number } | { type: "ref"; ref: string };
type Reply = { content: Array<TextBlock | ImageBlock>; changes?: StateChange[]; forceState?: boolean };

/** Runs Claude's `browser_toolset_20260801` calls on a browser reached through
 *  Browser Gateway and answers each with the result block the API expects. */
export class AnthropicBrowserExecutor {
  private readonly downloadsReported = new Map<string, string>();
  private logCursor = 0;

  private constructor(
    readonly session: ComputerUseSession,
    private readonly opts: AnthropicBrowserOptions,
  ) {}

  static async connect(opts: AnthropicBrowserOptions): Promise<AnthropicBrowserExecutor> {
    const session = await ComputerUseSession.open("anthropic-browser", opts);
    return new AnthropicBrowserExecutor(session, opts);
  }

  /** The `tools` entry for this executor: optional members on only when it runs them. */
  declaration(): { type: string; configs?: Record<string, { enabled: boolean }> } {
    const configs: Record<string, { enabled: boolean }> = {};
    if (this.opts.logs) {
      configs.read_console = { enabled: true };
      configs.read_network = { enabled: true };
    }
    if (this.opts.javascript) configs.javascript_exec = { enabled: true };
    return Object.keys(configs).length ? { type: TOOLSET_TYPE, configs } : { type: TOOLSET_TYPE };
  }

  /** Answers every browser call in one assistant turn, in order. After the first
   *  failure the rest are answered with the halt text and not run. Other blocks
   *  (text, thinking, your own tools) are skipped. */
  async run(content: unknown[]): Promise<ToolResultBlock[]> {
    const calls = content.filter(isBrowserCall);
    const { results, failed } = await runBatch(calls, TOOLSET, HALT_TEXT, (call) => this.runOne(call));
    if (this.opts.attachScreenshot && !failed) await this.attachObservation(calls, results);
    return results;
  }

  /** Runs one call and returns its result; never throws for a failed action. */
  async runOne(call: ToolUseBlock): Promise<ToolResultBlock> {
    try {
      const tabId = this.tabIdFrom(call.input.tab_id);
      const before = await this.session.agent.tabInventory();
      const reply = await this.dispatch(call.name, call.input, tabId);
      const after = await this.session.agent.tabInventory();
      await this.enforceUrlPolicy(after);
      const state = this.stateBlock(before, after, reply.changes ?? [], TAB_MEMBERS.has(call.name) || reply.forceState);
      if (TAB_MEMBERS.has(call.name)) return okResult(call.id, [state!]);
      return okResult(call.id, state ? [...reply.content, state] : reply.content);
    } catch (err) {
      return errorResult(call.id, `Error: ${messageOf(err)}`);
    }
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  private async dispatch(name: string, input: Record<string, unknown>, tabId: string | undefined): Promise<Reply> {
    const agent = this.session.agent;
    switch (name) {
      case "navigate": {
        const url = requireString(input.url, "url");
        if (url === "back" || url === "forward" || url === "reload") {
          const res = await agent.history(url, tabId);
          return text(url === "reload" ? `Reloaded ${res.url}.` : `Went ${url} to ${res.url}.`);
        }
        let opened: string;
        try {
          opened = await this.session.navigate(url, tabId);
        } catch (err) {
          if (/only http and https/.test(messageOf(err))) throw new MemberError("Navigation refused. Only http and https URLs are allowed.");
          throw err;
        }
        return text(`Navigated to ${opened}.`);
      }
      case "screenshot":
        return { content: [image(await this.session.observe(tabId))] };
      case "zoom": {
        const region = input.region;
        if (!Array.isArray(region) || region.length !== 4 || !region.every((v) => typeof v === "number")) {
          throw new MemberError("region must be [x0, y0, x1, y1] in viewport pixels.");
        }
        const [x0, y0, x1, y1] = region as number[];
        return { content: [image(await this.session.zoom({ x0: x0!, y0: y0!, x1: x1!, y1: y1! }, tabId))] };
      }
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click":
        return this.click(name, input, tabId);
      case "hover": {
        const target = requireTarget(input.target);
        if (target.type === "ref") await this.refAction({ type: "hover", ref: target.ref }, tabId);
        else await agent.mouseMove(this.point(target), tabId);
        return text(`Hovered ${describe(target)}.`);
      }
      case "left_click_drag": {
        const from = this.point(requireCoordinate(input.from, "from"));
        const to = this.point(requireCoordinate(input.target, "target"));
        await agent.drag(from, to, tabId);
        await this.session.settle(tabId);
        return text("Dragged.");
      }
      case "left_mouse_down":
        await agent.mouseDown(this.point(requireCoordinate(input.target, "target")), "left", tabId);
        return text("Left button pressed.");
      case "left_mouse_up":
        await agent.mouseUp(this.point(requireCoordinate(input.target, "target")), "left", tabId);
        await this.session.settle(tabId);
        return text("Left button released.");
      case "mouse_move":
        await agent.mouseMove(this.point(requireCoordinate(input.target, "target")), tabId);
        return text("Pointer moved.");
      case "scroll": {
        const at = this.point(requireCoordinate(input.target, "target"));
        const amount = clampInt(input.scroll_amount, 1, 10, 3) * SCROLL_PX_PER_NOTCH;
        const direction = String(input.scroll_direction ?? "");
        const delta: Record<string, Point> = {
          up: { x: 0, y: -amount },
          down: { x: 0, y: amount },
          left: { x: -amount, y: 0 },
          right: { x: amount, y: 0 },
        };
        const d = delta[direction];
        if (!d) throw new MemberError('scroll_direction must be "up", "down", "left" or "right".');
        await agent.wheel(at, d.x, d.y, tabId);
        await this.session.settle(tabId);
        return text(`Scrolled ${direction}.`);
      }
      case "scroll_to": {
        const target = requireTarget(input.target);
        if (target.type !== "ref") throw new MemberError("scroll_to needs a ref target.");
        await this.refAction({ type: "hover", ref: target.ref }, tabId);
        return text(`Scrolled ${target.ref} into view.`);
      }
      case "type":
        await agent.typeText(requireString(input.text, "text"), tabId);
        return text("Typed.");
      case "key": {
        const keys = requireString(input.text, "text");
        await agent.pressKeys(keys, clampInt(input.repeat, 1, 100, 1), tabId);
        await this.session.settle(tabId);
        return text(`Pressed ${keys}.`);
      }
      case "hold_key": {
        const keys = requireString(input.text, "text");
        const seconds = clampSeconds(input.duration, MAX_HOLD_S);
        const parts = chordKeys(keys);
        for (const part of parts) await agent.keyDown(part, tabId);
        try {
          await delay(seconds * 1000);
        } finally {
          for (const part of [...parts].reverse()) await agent.keyUp(part, tabId);
        }
        return text(`Held ${keys} for ${seconds} seconds.`);
      }
      case "wait": {
        const seconds = clampSeconds(input.duration, MAX_HOLD_S);
        await delay(seconds * 1000);
        return text(`Waited ${seconds} seconds.`);
      }
      case "read_page": {
        const filter = input.filter === "interactive" || input.filter === "all" ? input.filter : "visible";
        const depth = clampInt(input.depth, 1, Number.MAX_SAFE_INTEGER, 15);
        const ref = typeof input.ref === "string" ? input.ref : undefined;
        try {
          return text((await agent.readPage({ filter, depth, ref }, tabId)).text);
        } catch (err) {
          throw staleRef(err, ref);
        }
      }
      case "find": {
        const query = requireString(input.query, "query");
        const matches = await agent.find(query, tabId);
        if (matches.length === 0) return text(`No elements match "${query}".`);
        return text(matches.map((m) => `${m.role}${m.name ? ` "${m.name}"` : ""} [${m.ref}]`).join("\n"));
      }
      case "get_page_text":
        return text((await agent.extract({ format: "text", maxChars: PAGE_TEXT_MAX_CHARS }, tabId)).text || "(no visible text)");
      case "form_input":
        return this.formInput(input, tabId);
      case "read_console":
      case "read_network":
        return this.readLogs(name);
      case "javascript_exec": {
        if (!this.opts.javascript) throw new MemberError("javascript_exec is not enabled for this session.");
        const value = await agent.evaluate(requireString(input.text, "text"), tabId);
        const shown = typeof value === "string" ? value : JSON.stringify(value) ?? "undefined";
        return text(shown.length > PAGE_TEXT_MAX_CHARS ? `${shown.slice(0, PAGE_TEXT_MAX_CHARS)}... (cut)` : shown);
      }
      case "file_upload":
        throw new MemberError("file_upload is not available in this executor.");
      case "new_tab": {
        const tab = await agent.openTab();
        await agent.activateTab(tab.tabId);
        return { content: [], changes: [{ type: "tab_opened", tab_id: tab.tabId }] };
      }
      case "list_tabs":
        return { content: [] };
      case "switch_tab":
        await agent.activateTab(this.requireTab(input.tab_id));
        return { content: [] };
      case "close_tab":
        await agent.closeTab(this.requireTab(input.tab_id));
        return { content: [] };
      default:
        throw new MemberError(`${name} is not a browser tool this executor runs.`);
    }
  }

  private async click(name: string, input: Record<string, unknown>, tabId: string | undefined): Promise<Reply> {
    const target = requireTarget(input.target);
    const button: MouseButton = name === "right_click" ? "right" : name === "middle_click" ? "middle" : "left";
    const clickCount = name === "double_click" ? 2 : name === "triple_click" ? 3 : 1;
    const modifiers = typeof input.modifiers === "string" && input.modifiers ? modifiersOf(input.modifiers) : undefined;
    if (target.type === "ref") {
      await this.refAction({ type: "click", ref: target.ref, button, clickCount, modifiers }, tabId);
    } else {
      await this.session.agent.clickAt(this.point(target), { button, clickCount, modifiers }, tabId);
      await this.session.settle(tabId);
    }
    return text(`Clicked ${describe(target)}.`);
  }

  private async formInput(input: Record<string, unknown>, tabId: string | undefined): Promise<Reply> {
    const target = requireTarget(input.target);
    if (target.type !== "ref") throw new MemberError("form_input needs a ref target.");
    const value = input.value;
    if (typeof value === "boolean") {
      await this.refAction({ type: value ? "check" : "uncheck", ref: target.ref }, tabId);
      return text(`Set ${target.ref} to ${value}.`);
    }
    if (typeof value !== "string" && typeof value !== "number") throw new MemberError("value must be a string, number or boolean.");
    const role = this.session.agent.tab(tabId)?.refs.get(target.ref)?.role;
    const type = role === "combobox" || role === "listbox" ? "select" : "fill";
    try {
      await this.refAction({ type, ref: target.ref, text: String(value) }, tabId);
    } catch (err) {
      if (type !== "select" || !/no option matching/.test(messageOf(err))) throw err;
      await this.refAction({ type: "fill", ref: target.ref, text: String(value) }, tabId);
    }
    return text(`Set ${target.ref} to "${String(value)}".`);
  }

  private readLogs(name: "read_console" | "read_network"): Reply {
    if (!this.opts.logs) throw new MemberError(`${name} is not enabled for this session.`);
    const { console: entries, requests, cursor } = this.session.agent.readLogs(this.logCursor);
    this.logCursor = cursor;
    const lines =
      name === "read_console"
        ? entries.map((e) => `[${e.level}] ${redactSecrets(e.text).slice(0, LOG_LINE_MAX)}`)
        : requests.map((r) => `${r.method} ${r.url} ${r.failed ? `failed: ${r.failed}` : (r.status ?? "pending")}${r.type ? ` ${r.type}` : ""}`);
    return text(lines.length ? lines.join("\n") : name === "read_console" ? "No new console entries." : "No new network requests.");
  }

  private async refAction(step: ActionStep, tabId: string | undefined): Promise<void> {
    const res = await this.session.agent.act([step], { tabId, settleMs: this.session.settleMs, snapshot: { maxLines: 1 } });
    if (!res.ok) {
      const error = res.failedStep?.error ?? "action failed";
      if (/no longer on the page/.test(error)) throw staleRefMessage(step.ref);
      throw new MemberError(error);
    }
  }

  private point(target: { x: number; y: number }): Point {
    return this.session.toPage({ x: Number(target.x), y: Number(target.y) });
  }

  private tabIdFrom(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    return this.requireTab(value);
  }

  private requireTab(value: unknown): string {
    const id = typeof value === "string" ? value : "";
    if (!id || id.length > FIELD_MAX || hasControlChars(id)) throw new MemberError("tab_id is missing or not valid.");
    if (!this.session.agent.tabIds.includes(id)) throw new MemberError(`there is no open tab ${id}. Call list_tabs to see open tabs.`);
    return id;
  }

  private async enforceUrlPolicy(tabs: TabInfo[]): Promise<void> {
    for (const tab of tabs) {
      if (!tab.url || tab.url === "about:blank") continue;
      try {
        checkUrl(tab.url, this.session.urlPolicy);
      } catch (err) {
        await this.session.agent.navigate("about:blank", tab.tabId).catch(() => undefined);
        throw new MemberError(`tab ${tab.tabId} reached an address this session may not open: ${messageOf(err)}`, { cause: err });
      }
    }
  }

  private stateBlock(before: TabInfo[], after: TabInfo[], changes: StateChange[], force = false): BrowserStateBlock | null {
    const opened = after.filter((t) => !before.some((b) => b.tabId === t.tabId));
    const all: StateChange[] = [...changes];
    for (const tab of opened) {
      if (!all.some((c) => c.type === "tab_opened" && c.tab_id === tab.tabId)) all.push({ type: "tab_opened", tab_id: tab.tabId });
    }
    all.push(...this.downloadChanges());
    const changed =
      force ||
      all.length > 0 ||
      before.length !== after.length ||
      after.some((t) => {
        const prev = before.find((b) => b.tabId === t.tabId);
        return !prev || prev.url !== t.url || prev.title !== t.title || prev.active !== t.active;
      });
    if (!changed) return null;
    const block: BrowserStateBlock = { type: "browser_state", tabs: after.map(tabEntry) };
    if (all.length > 0) block.state_changes = all;
    return block;
  }

  private downloadChanges(): StateChange[] {
    const out: StateChange[] = [];
    for (const d of this.session.agent.observed().downloads) {
      if (!d.id) continue;
      const reported = this.downloadsReported.get(d.id);
      const url = sanitizeUrl(d.url);
      if (!reported) out.push({ type: "download_started", download_id: d.id, url });
      if (d.state !== "started" && reported !== d.state) {
        out.push(d.state === "completed" ? { type: "download_completed", download_id: d.id, url } : { type: "download_failed", download_id: d.id, url });
      }
      this.downloadsReported.set(d.id, d.state);
    }
    return out;
  }

  private async attachObservation(calls: ToolUseBlock[], results: ToolResultBlock[]): Promise<void> {
    for (let i = results.length - 1; i >= 0; i--) {
      if (TAB_MEMBERS.has(calls[i]!.name)) continue;
      if (results[i]!.content.some((c) => c.type === "image")) return;
      try {
        const shot = image(await this.session.observe());
        const content = results[i]!.content;
        const stateAt = content.findIndex((c) => c.type === "browser_state");
        if (stateAt < 0) content.push(shot);
        else content.splice(stateAt, 0, shot);
      } catch {
        /* the page may be mid-navigation; the model can ask for a screenshot */
      }
      return;
    }
  }
}


function isBrowserCall(block: unknown): block is ToolUseBlock {
  const b = block as Partial<ToolUseBlock> | null;
  return !!b && b.type === "tool_use" && b.toolset_name === TOOLSET && typeof b.id === "string" && typeof b.name === "string";
}

function okResult(id: string, content: ToolResultBlock["content"]): ToolResultBlock {
  return sharedOk(id, TOOLSET, content);
}

function errorResult(id: string, message: string): ToolResultBlock {
  return sharedError(id, TOOLSET, message);
}

function text(value: string): Reply {
  return { content: [textBlock(value)] };
}

function tabEntry(tab: TabInfo): TabEntry {
  const entry: TabEntry = {
    tab_id: tab.tabId,
    title: stripControl(tab.title).slice(0, TITLE_MAX),
    url: sanitizeUrl(tab.url),
  };
  if (tab.active) entry.active = true;
  return entry;
}

/** Drops credentials and blanks secret-looking query values in a page-supplied URL. */
function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    for (const key of [...u.searchParams.keys()]) if (SECRET_PARAM.test(key)) u.searchParams.set(key, "redacted");
    return stripControl(u.toString()).slice(0, FIELD_MAX);
  } catch {
    return stripControl(raw).slice(0, FIELD_MAX);
  }
}

function redactSecrets(line: string): string {
  return line.replace(/([?&](?:[^=&\s]*(?:token|key|secret|sig|auth|password|session|code)[^=&\s]*)=)[^&\s]+/gi, "$1redacted");
}

function isControl(code: number): boolean {
  return code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029;
}

function stripControl(value: string): string {
  let out = "";
  for (const ch of value) out += isControl(ch.charCodeAt(0)) ? " " : ch;
  return out;
}

function hasControlChars(value: string): boolean {
  for (const ch of value) if (isControl(ch.charCodeAt(0))) return true;
  return false;
}

function requireTarget(value: unknown): Target {
  const t = value as Partial<Target> | null;
  if (t?.type === "ref" && typeof (t as { ref?: unknown }).ref === "string") return t as Target;
  if (t?.type === "coordinate") return requireCoordinate(t, "target");
  throw new MemberError('target must be {"type": "coordinate", "x", "y"} or {"type": "ref", "ref"}.');
}

function requireCoordinate(value: unknown, field: string): { type: "coordinate"; x: number; y: number } {
  const t = value as { type?: string; x?: unknown; y?: unknown } | null;
  if (t?.type !== "coordinate" || typeof t.x !== "number" || typeof t.y !== "number") {
    throw new MemberError(`${field} must be a coordinate target {"type": "coordinate", "x", "y"}.`);
  }
  return { type: "coordinate", x: t.x, y: t.y };
}

function describe(target: Target): string {
  return target.type === "ref" ? `element ${target.ref}` : `(${target.x}, ${target.y})`;
}

function staleRefMessage(ref: string | undefined): MemberError {
  return new MemberError(`${ref ?? "that ref"} is stale or not found on the current page. Re-read the page to get fresh references.`);
}

function staleRef(err: unknown, ref: string | undefined): unknown {
  return /no longer on the page/.test(messageOf(err)) ? staleRefMessage(ref) : err;
}
