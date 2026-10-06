import type { Point } from "../types.js";
import { geminiLength } from "./frame.js";
import { ComputerUseSession, type ComputerUseOptions, type Observation } from "./session.js";

const DEFAULT_SCROLL_PX = 300;
const LEGACY_SCROLL_GRID = 800;
const MAX_WAIT_S = 30;
const LEGACY_WAIT_S = 5;
const DEFAULT_SEARCH_URL = "https://www.google.com";

/** A function call in either Gemini response shape: an Interactions API step
 *  (`type: "function_call"`) or a generateContent part (`functionCall`). */
export type GeminiCall =
  | { type: "function_call"; id?: string; name: string; arguments?: Record<string, unknown> }
  | { functionCall: { id?: string; name: string; args?: Record<string, unknown> } };

export interface SafetyRequest {
  action: string;
  explanation: string;
  arguments: Record<string, unknown>;
}

export interface GeminiOptions extends ComputerUseOptions {
  /** Asked before any action Gemini marks `require_confirmation`. Returning
   *  false stops the run. Without it such actions are declined. */
  confirm?: (request: SafetyRequest) => Promise<boolean>;
  /** Keep tabs a page opens as separate tabs. Default false: the opened page
   *  replaces the current one, since Gemini works in a single tab. */
  keepTabs?: boolean;
  /** Where the legacy `search` action goes. Default https://www.google.com. */
  searchUrl?: string;
}

/** Interactions API result item. */
export interface GeminiFunctionResult {
  type: "function_result";
  name: string;
  call_id?: string;
  result: Array<{ type: "text"; text: string } | { type: "image"; data: string; mime_type: string }>;
}

/** generateContent result part. */
export interface GeminiFunctionResponsePart {
  functionResponse: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
    parts: Array<{ inlineData: { mimeType: string; data: string } }>;
  };
}

export interface GeminiRunResult<R> {
  /** One result per executed call, in order. */
  results: R[];
  /** True when a person declined a confirmation; stop the loop. */
  terminated: boolean;
  /** Calls to functions this executor does not run (your own tools); answer them yourself. */
  unhandled: GeminiCall[];
}

interface Normalized {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  shape: "interactions" | "generate";
  original: GeminiCall;
}

const PREDEFINED = new Set([
  "click", "double_click", "triple_click", "middle_click", "right_click", "mouse_down", "mouse_up", "move",
  "type", "drag_and_drop", "wait", "press_key", "key_down", "key_up", "hotkey", "take_screenshot", "scroll",
  "go_back", "go_forward", "navigate", "open_web_browser", "click_at", "hover_at", "type_text_at",
  "scroll_document", "scroll_at", "wait_5_seconds", "search", "key_combination", "open_app", "list_apps",
  "long_press",
]);

/** Runs Gemini computer-use actions (browser environment) on a browser reached
 *  through Browser Gateway and builds the function results Gemini expects. */
export class GeminiExecutor {
  private constructor(
    readonly session: ComputerUseSession,
    private readonly opts: GeminiOptions,
  ) {}

  static async connect(opts: GeminiOptions): Promise<GeminiExecutor> {
    const session = await ComputerUseSession.open("gemini", opts);
    return new GeminiExecutor(session, opts);
  }

  /** The `tools` entry for an Interactions API request. */
  declaration(): { type: "computer_use"; environment: "browser" } {
    return { type: "computer_use", environment: "browser" };
  }

  /** The screenshot and address to send with the first request. */
  async initialObservation(): Promise<Observation> {
    return this.session.observe();
  }

  /** Runs every computer-use call in a response, in order, and returns one result
   *  per call carrying the page address and a fresh screenshot. A failed action
   *  is reported in its result and the rest still run, as Gemini expects. */
  async run(calls: unknown[]): Promise<GeminiRunResult<GeminiFunctionResult | GeminiFunctionResponsePart>> {
    const normalized = calls.map(normalize).filter((c): c is Normalized => c !== null);
    const unhandled = normalized.filter((c) => !PREDEFINED.has(c.name)).map((c) => c.original);
    const outcomes: Array<{ call: Normalized; result: Record<string, unknown> }> = [];
    let terminated = false;

    for (const call of normalized) {
      if (!PREDEFINED.has(call.name)) continue;
      const result: Record<string, unknown> = {};
      const decision = call.args.safety_decision as { decision?: string; explanation?: string } | undefined;
      if (decision?.decision === "require_confirmation") {
        const ok = this.opts.confirm
          ? await this.opts.confirm({ action: call.name, explanation: decision.explanation ?? "", arguments: call.args }).catch(() => false)
          : false;
        if (!ok) {
          terminated = true;
          break;
        }
        result.safety_acknowledgement = true;
      }
      try {
        await this.dispatch(call.name, call.args);
        await this.collapsePopups();
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
      }
      outcomes.push({ call, result });
    }

    if (outcomes.length === 0) return { results: [], terminated, unhandled };
    const seen = await this.session.observe();
    const results = outcomes.map(({ call, result }) => format(call, { url: seen.url, ...result }, seen));
    return { results, terminated, unhandled };
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  private async dispatch(name: string, a: Record<string, unknown>): Promise<void> {
    const agent = this.session.agent;
    switch (name) {
      case "click":
      case "click_at":
        return this.clickAt(a, {});
      case "double_click":
        return this.clickAt(a, { clickCount: 2 });
      case "triple_click":
        return this.clickAt(a, { clickCount: 3 });
      case "middle_click":
        return this.clickAt(a, { button: "middle" });
      case "right_click":
        return this.clickAt(a, { button: "right" });
      case "move":
      case "hover_at":
        return agent.mouseMove(this.point(a.x, a.y));
      case "mouse_down":
        return agent.mouseDown(this.point(a.x, a.y));
      case "mouse_up":
        await agent.mouseUp(this.point(a.x, a.y));
        return this.session.settle();
      case "type":
      case "type_text_at": {
        const text = requireString(a.text, "text");
        const hasPoint = a.x !== undefined && a.y !== undefined;
        if (hasPoint) await agent.clickAt(this.point(a.x, a.y));
        const clear = name === "type_text_at" ? a.clear_before_typing !== false : hasPoint;
        if (clear) {
          await agent.pressKeys(["Control", "a"]);
          await agent.pressKeys("Backspace");
        }
        await agent.typeText(text);
        if (a.press_enter === true) await agent.pressKeys("Enter");
        return this.session.settle();
      }
      case "drag_and_drop": {
        const from = this.point(a.start_x ?? a.x, a.start_y ?? a.y);
        const to = this.point(a.end_x ?? a.destination_x, a.end_y ?? a.destination_y);
        await agent.drag(from, to);
        return this.session.settle();
      }
      case "wait":
        return delay(Math.min(Math.max(Number(a.seconds ?? 1), 0), MAX_WAIT_S) * 1000);
      case "wait_5_seconds":
        return delay(LEGACY_WAIT_S * 1000);
      case "press_key":
        await agent.pressKeys([requireString(a.key, "key")]);
        return this.session.settle();
      case "key_down":
        return agent.keyDown(requireString(a.key, "key"));
      case "key_up":
        return agent.keyUp(requireString(a.key, "key"));
      case "hotkey": {
        if (!Array.isArray(a.keys) || a.keys.length === 0) throw new Error("keys must be a list of key names");
        await agent.pressKeys(a.keys.map(String));
        return this.session.settle();
      }
      case "key_combination":
        await agent.pressKeys(requireString(a.keys, "keys").split("+"));
        return this.session.settle();
      case "scroll":
      case "scroll_at":
        return this.scroll(a);
      case "scroll_document": {
        const direction = String(a.direction ?? "down");
        if (direction === "down" || direction === "up") {
          await agent.pressKeys(direction === "down" ? "PageDown" : "PageUp");
        } else {
          const v = await agent.viewport();
          await agent.wheel({ x: v.width / 2, y: v.height / 2 }, (direction === "right" ? 1 : -1) * (v.width / 2), 0);
        }
        return this.session.settle();
      }
      case "take_screenshot":
      case "open_web_browser":
        return;
      case "navigate":
        await this.session.navigate(requireString(a.url, "url"));
        return;
      case "search":
        await this.session.navigate(this.opts.searchUrl ?? DEFAULT_SEARCH_URL);
        return;
      case "go_back":
        await agent.history("back");
        return;
      case "go_forward":
        await agent.history("forward");
        return;
      default:
        throw new Error(`${name} is not available in a browser environment`);
    }
  }

  private async clickAt(a: Record<string, unknown>, opts: { button?: "middle" | "right"; clickCount?: number }): Promise<void> {
    await this.session.agent.clickAt(this.point(a.x, a.y), opts);
    await this.session.settle();
  }

  private async scroll(a: Record<string, unknown>): Promise<void> {
    const v = await this.session.agent.viewport();
    const at = a.x !== undefined && a.y !== undefined ? this.point(a.x, a.y) : { x: v.width / 2, y: v.height / 2 };
    const direction = String(a.direction ?? "down");
    const vertical = direction === "up" || direction === "down";
    let px: number;
    if (a.magnitude_in_pixels !== undefined) px = Math.min(Math.max(Number(a.magnitude_in_pixels), 0), 999);
    else if (a.magnitude !== undefined) px = geminiLength(Number(a.magnitude), vertical ? v.height : v.width);
    else px = a.x === undefined ? geminiLength(LEGACY_SCROLL_GRID, vertical ? v.height : v.width) : DEFAULT_SCROLL_PX;
    const sign = direction === "up" || direction === "left" ? -1 : 1;
    if (!["up", "down", "left", "right"].includes(direction)) throw new Error('direction must be "up", "down", "left" or "right"');
    await this.session.agent.wheel(at, vertical ? 0 : sign * px, vertical ? sign * px : 0);
    await this.session.settle();
  }

  private point(x: unknown, y: unknown): Point {
    if (typeof x !== "number" || typeof y !== "number") throw new Error("x and y must be numbers on the 0-999 grid");
    return this.session.fromGrid({ x, y });
  }

  /** Gemini works in one tab: a page the action opened replaces the current one. */
  private async collapsePopups(): Promise<void> {
    if (this.opts.keepTabs) return;
    const agent = this.session.agent;
    const tabs = await agent.tabInventory();
    const active = tabs.find((t) => t.active);
    const extra = tabs.filter((t) => !t.active);
    if (!active || extra.length === 0) return;
    const target = extra[extra.length - 1]!.url;
    for (const tab of extra) await agent.closeTab(tab.tabId).catch(() => undefined);
    if (target && target !== "about:blank") await this.session.navigate(target, active.tabId);
  }
}

function normalize(raw: unknown): Normalized | null {
  const step = raw as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> } | null;
  if (step?.type === "function_call" && typeof step.name === "string") {
    return { id: step.id, name: step.name, args: step.arguments ?? {}, shape: "interactions", original: raw as GeminiCall };
  }
  const part = raw as { functionCall?: { id?: string; name?: string; args?: Record<string, unknown> } } | null;
  if (part?.functionCall && typeof part.functionCall.name === "string") {
    return { id: part.functionCall.id, name: part.functionCall.name, args: part.functionCall.args ?? {}, shape: "generate", original: raw as GeminiCall };
  }
  return null;
}

function format(call: Normalized, payload: Record<string, unknown>, seen: Observation): GeminiFunctionResult | GeminiFunctionResponsePart {
  if (call.shape === "interactions") {
    const item: GeminiFunctionResult = {
      type: "function_result",
      name: call.name,
      result: [
        { type: "text", text: JSON.stringify(payload) },
        { type: "image", data: seen.base64, mime_type: seen.mimeType },
      ],
    };
    if (call.id) item.call_id = call.id;
    return item;
  }
  const part: GeminiFunctionResponsePart = {
    functionResponse: { name: call.name, response: payload, parts: [{ inlineData: { mimeType: seen.mimeType, data: seen.base64 } }] },
  };
  if (call.id) part.functionResponse.id = call.id;
  return part;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${field} is required`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
