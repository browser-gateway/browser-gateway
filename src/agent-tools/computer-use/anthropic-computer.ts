import type { MouseButton } from "../input.js";
import type { Point } from "../types.js";
import { pageToFrame } from "./frame.js";
import { ComputerUseSession, type ComputerUseOptions } from "./session.js";
import {
  chordKeys,
  clampInt,
  clampSeconds,
  delay,
  errorResult,
  imageBlock,
  MAX_HOLD_S,
  MemberError,
  messageOf,
  modifiersOf,
  okResult,
  requireString,
  runBatch,
  SCROLL_PX_PER_NOTCH,
  textBlock,
} from "./anthropic-shared.js";
import type { ImageBlock, TextBlock, ToolResultBlock, ToolUseBlock } from "./types.js";

const TOOLSET = "computer";
const TOOLSET_TYPE = "computer_toolset_20260801";
const LEGACY_TYPE = "computer_20251124";
const LEGACY_NAME = "computer";
const HALT_TEXT = "Not executed: an earlier computer action in this turn failed.";
const MAX_SCROLL_NOTCHES = 100;

export interface AnthropicComputerOptions extends ComputerUseOptions {
  /** Answer the earlier `computer_20251124` tool (one `computer` tool with an
   *  `action` field), for models and platforms that do not take the toolset. */
  legacy?: boolean;
}

/** Runs Claude's computer use calls (`computer_toolset_20260801`, or the earlier
 *  `computer_20251124` tool) on a browser page reached through Browser Gateway.
 *  The page is the whole "display". */
export class AnthropicComputerExecutor {
  private constructor(
    readonly session: ComputerUseSession,
    private readonly opts: AnthropicComputerOptions,
  ) {}

  static async connect(opts: AnthropicComputerOptions): Promise<AnthropicComputerExecutor> {
    const session = await ComputerUseSession.open("anthropic-computer", opts);
    return new AnthropicComputerExecutor(session, opts);
  }

  /** The `tools` entry. The earlier tool also declares the display size, so call
   *  it after connecting and keep the page size fixed. */
  declaration(): Record<string, unknown> {
    if (!this.opts.legacy) return { type: TOOLSET_TYPE };
    const { width, height } = this.session.frame;
    return { type: LEGACY_TYPE, name: LEGACY_NAME, display_width_px: width, display_height_px: height, enable_zoom: true };
  }

  /** Answers every computer call in one assistant turn, in order, stopping at the first failure. */
  async run(content: unknown[]): Promise<ToolResultBlock[]> {
    const calls = content.filter((b) => this.isCall(b)) as ToolUseBlock[];
    const toolset = this.opts.legacy ? undefined : TOOLSET;
    const { results } = await runBatch(calls, toolset, HALT_TEXT, (call) => this.runOne(call));
    return results;
  }

  /** Runs one call; never throws for a failed action. */
  async runOne(call: ToolUseBlock): Promise<ToolResultBlock> {
    const toolset = this.opts.legacy ? undefined : TOOLSET;
    const { action, input } = this.opts.legacy
      ? { action: String(call.input.action ?? ""), input: call.input }
      : { action: call.name, input: call.input };
    try {
      return okResult(call.id, toolset, await this.dispatch(action, input));
    } catch (err) {
      return errorResult(call.id, toolset, `Error: ${messageOf(err)}`);
    }
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  private isCall(block: unknown): boolean {
    const b = block as Partial<ToolUseBlock> | null;
    if (!b || b.type !== "tool_use" || typeof b.id !== "string") return false;
    return this.opts.legacy ? b.name === LEGACY_NAME && !b.toolset_name : b.toolset_name === TOOLSET;
  }

  private async dispatch(action: string, input: Record<string, unknown>): Promise<Array<TextBlock | ImageBlock>> {
    const agent = this.session.agent;
    switch (action) {
      case "screenshot":
        return [imageBlock(await this.session.observe())];
      case "zoom": {
        const r = input.region;
        if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => typeof v === "number")) {
          throw new MemberError("region must be [x0, y0, x1, y1] in screenshot pixels.");
        }
        return [imageBlock(await this.session.zoom({ x0: r[0], y0: r[1], x1: r[2], y1: r[3] }))];
      }
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click": {
        const button: MouseButton = action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
        const clickCount = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
        const at = this.pointOr(input.coordinate);
        const modifiers = typeof input.text === "string" && input.text ? modifiersOf(input.text) : undefined;
        await agent.clickAt(at, { button, clickCount, modifiers });
        await this.session.settle();
        return [textBlock(`Clicked at ${this.describe(at)}.`)];
      }
      case "left_click_drag": {
        const from = this.point(input.start_coordinate, "start_coordinate");
        const to = this.point(input.coordinate, "coordinate");
        await this.withHeld(input.text, () => agent.drag(from, to));
        await this.session.settle();
        return [textBlock("Dragged.")];
      }
      case "mouse_move":
        await agent.mouseMove(this.point(input.coordinate, "coordinate"));
        return [textBlock("Moved the pointer.")];
      case "left_mouse_down":
        await agent.mouseDown(input.coordinate !== undefined ? this.point(input.coordinate, "coordinate") : undefined);
        return [textBlock("Left button pressed.")];
      case "left_mouse_up":
        await agent.mouseUp(input.coordinate !== undefined ? this.point(input.coordinate, "coordinate") : undefined);
        await this.session.settle();
        return [textBlock("Left button released.")];
      case "cursor_position": {
        const p = pageToFrame(this.cursor(), this.session.frame);
        return [textBlock(`X=${p.x}, Y=${p.y}`)];
      }
      case "scroll": {
        const at = this.pointOr(input.coordinate);
        const px = clampInt(input.scroll_amount, 1, MAX_SCROLL_NOTCHES, 3) * SCROLL_PX_PER_NOTCH;
        const direction = String(input.scroll_direction ?? "");
        const delta: Record<string, Point> = { up: { x: 0, y: -px }, down: { x: 0, y: px }, left: { x: -px, y: 0 }, right: { x: px, y: 0 } };
        const d = delta[direction];
        if (!d) throw new MemberError('scroll_direction must be "up", "down", "left" or "right".');
        await this.withHeld(input.text, () => agent.wheel(at, d.x, d.y));
        await this.session.settle();
        return [textBlock(`Scrolled ${direction}.`)];
      }
      case "type":
        await agent.typeText(requireString(input.text, "text"));
        return [textBlock("Typed.")];
      case "key": {
        const keys = requireString(input.text, "text");
        await agent.pressKeys(keys, clampInt(input.repeat, 1, 100, 1));
        await this.session.settle();
        return [textBlock(`Pressed ${keys}.`)];
      }
      case "hold_key": {
        const keys = requireString(input.text, "text");
        const asked = typeof input.duration === "number" ? input.duration : 0;
        const seconds = clampSeconds(asked, MAX_HOLD_S);
        await this.withHeld(keys, () => delay(seconds * 1000));
        return [textBlock(asked > MAX_HOLD_S ? `Held ${keys} for ${seconds} seconds, the most this session allows.` : `Held ${keys} for ${seconds} seconds.`)];
      }
      case "wait": {
        const asked = typeof input.duration === "number" ? input.duration : 0;
        const seconds = clampSeconds(asked, MAX_HOLD_S);
        await delay(seconds * 1000);
        return [textBlock(asked > MAX_HOLD_S ? `Waited ${seconds} seconds, the most this session allows.` : `Waited ${seconds} seconds.`)];
      }
      default:
        throw new MemberError(`${action || "(no action)"} is not a computer action this executor runs.`);
    }
  }

  private async withHeld(keys: unknown, run: () => Promise<void>): Promise<void> {
    const parts = typeof keys === "string" && keys ? chordKeys(keys) : [];
    for (const key of parts) await this.session.agent.keyDown(key);
    try {
      await run();
    } finally {
      for (const key of [...parts].reverse()) await this.session.agent.keyUp(key);
    }
  }

  private point(value: unknown, field: string): Point {
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "number" || typeof value[1] !== "number") {
      throw new MemberError(`${field} must be [x, y] in screenshot pixels.`);
    }
    return this.session.toPage({ x: value[0], y: value[1] });
  }

  private pointOr(value: unknown): Point {
    return value === undefined ? this.cursor() : this.point(value, "coordinate");
  }

  private cursor(): Point {
    return this.session.agent.tab()?.input.position ?? { x: 0, y: 0 };
  }

  private describe(at: Point): string {
    const p = pageToFrame(at, this.session.frame);
    return `(${p.x}, ${p.y})`;
  }
}
