import { keySpecFor, MODIFIER_BITS, modifierMask, parseChord, type KeySpec, type ModifierKey } from "./keys.js";
import type { CdpSend, Point } from "./types.js";

export type MouseButton = "left" | "right" | "middle";

const BUTTON_BITS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };
const DRAG_STEPS = 10;

/** Pointer position and the buttons and keys still held down in one tab. Kept
 *  between calls so a press in one call and a release in a later one form one
 *  gesture. */
export class InputState {
  position: Point = { x: 0, y: 0 };
  buttons = 0;
  /** On macOS, editing shortcuts only take effect when sent as editor commands. */
  macEditing = false;
  readonly heldKeys = new Map<string, KeySpec>();

  get modifiers(): number {
    let mask = 0;
    for (const key of this.heldKeys.keys()) if (key in MODIFIER_BITS) mask |= MODIFIER_BITS[key as ModifierKey];
    return mask;
  }

  get heldButton(): MouseButton | "none" {
    if (this.buttons & 1) return "left";
    if (this.buttons & 2) return "right";
    if (this.buttons & 4) return "middle";
    return "none";
  }
}

export interface ClickOptions {
  button?: MouseButton;
  clickCount?: number;
  modifiers?: ModifierKey[];
}

type InputEvents = Array<[string, Record<string, unknown>]>;

/** Input events for one gesture are written back to back without awaiting each in
 *  turn: the browser processes them in arrival order, so the gesture costs one
 *  round trip instead of one per event. */
export function dispatchAll(send: CdpSend, sessionId: string, events: InputEvents): Promise<unknown[]> {
  return Promise.all(events.map(([method, params]) => send(method, params, sessionId)));
}

function mouseEvent(type: string, point: Point, extra: Record<string, unknown>): [string, Record<string, unknown>] {
  return ["Input.dispatchMouseEvent", { type, x: point.x, y: point.y, ...extra }];
}

export async function clickAt(
  send: CdpSend,
  sessionId: string,
  state: InputState,
  point: Point,
  opts: ClickOptions = {},
): Promise<void> {
  const button = opts.button ?? "left";
  const count = Math.min(Math.max(Math.trunc(opts.clickCount ?? 1), 1), 3);
  const modifiers = state.modifiers | modifierMask(opts.modifiers ?? []);
  const held = state.buttons | BUTTON_BITS[button];
  const events: InputEvents = [mouseEvent("mouseMoved", point, { buttons: state.buttons, modifiers })];
  for (let clickCount = 1; clickCount <= count; clickCount++) {
    events.push(mouseEvent("mousePressed", point, { button, clickCount, buttons: held, modifiers }));
    events.push(mouseEvent("mouseReleased", point, { button, clickCount, buttons: state.buttons, modifiers }));
  }
  await dispatchAll(send, sessionId, events);
  state.position = point;
}

export async function mouseMove(send: CdpSend, sessionId: string, state: InputState, point: Point): Promise<void> {
  await dispatchAll(send, sessionId, [
    mouseEvent("mouseMoved", point, { button: state.heldButton, buttons: state.buttons, modifiers: state.modifiers }),
  ]);
  state.position = point;
}

export async function mouseDown(
  send: CdpSend,
  sessionId: string,
  state: InputState,
  point: Point = state.position,
  button: MouseButton = "left",
): Promise<void> {
  const buttons = state.buttons | BUTTON_BITS[button];
  await dispatchAll(send, sessionId, [
    mouseEvent("mouseMoved", point, { button: state.heldButton, buttons: state.buttons, modifiers: state.modifiers }),
    mouseEvent("mousePressed", point, { button, clickCount: 1, buttons, modifiers: state.modifiers }),
  ]);
  state.buttons = buttons;
  state.position = point;
}

export async function mouseUp(
  send: CdpSend,
  sessionId: string,
  state: InputState,
  point: Point = state.position,
  button: MouseButton = "left",
): Promise<void> {
  const buttons = state.buttons & ~BUTTON_BITS[button];
  const events: InputEvents = [];
  if (point.x !== state.position.x || point.y !== state.position.y) {
    events.push(mouseEvent("mouseMoved", point, { button: state.heldButton, buttons: state.buttons, modifiers: state.modifiers }));
  }
  events.push(mouseEvent("mouseReleased", point, { button, clickCount: 1, buttons, modifiers: state.modifiers }));
  await dispatchAll(send, sessionId, events);
  state.buttons = buttons;
  state.position = point;
}

/** Press at `from`, move in steps, release at `to`. */
export async function drag(
  send: CdpSend,
  sessionId: string,
  state: InputState,
  from: Point,
  to: Point,
  steps = DRAG_STEPS,
): Promise<void> {
  await mouseDown(send, sessionId, state, from, "left");
  const events: InputEvents = [];
  for (let i = 1; i <= steps; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
    events.push(mouseEvent("mouseMoved", p, { button: "left", buttons: state.buttons, modifiers: state.modifiers }));
  }
  await dispatchAll(send, sessionId, events);
  state.position = to;
  await mouseUp(send, sessionId, state, to, "left");
}

export async function wheelAt(
  send: CdpSend,
  sessionId: string,
  state: InputState,
  point: Point,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await dispatchAll(send, sessionId, [mouseEvent("mouseWheel", point, { deltaX, deltaY, modifiers: state.modifiers })]);
  state.position = point;
}

function keyParams(type: string, spec: KeySpec, modifiers: number, text?: string): Record<string, unknown> {
  return {
    type,
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    modifiers,
    ...(text !== undefined ? { text, unmodifiedText: text } : {}),
  };
}

function typedText(spec: KeySpec, modifiers: number): string | undefined {
  if (!spec.text) return undefined;
  if (modifiers & ~MODIFIER_BITS.Shift) return undefined;
  return modifiers & MODIFIER_BITS.Shift && spec.text.length === 1 ? spec.text.toUpperCase() : spec.text;
}

const EDITING_COMMANDS: Record<string, string> = {
  a: "selectAll",
  c: "copy",
  v: "paste",
  x: "cut",
  z: "undo",
};

function editingCommand(spec: KeySpec, modifiers: number): string | undefined {
  if (!(modifiers & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta))) return undefined;
  if (modifiers & MODIFIER_BITS.Alt) return undefined;
  const letter = spec.key.toLowerCase();
  if (letter === "z" && modifiers & MODIFIER_BITS.Shift) return "redo";
  return EDITING_COMMANDS[letter];
}

function keyStrokeEvents(spec: KeySpec, modifiers: number, macEditing = false): InputEvents {
  const text = typedText(spec, modifiers);
  const command = macEditing ? editingCommand(spec, modifiers) : undefined;
  const down = keyParams(text ? "keyDown" : "rawKeyDown", spec, modifiers, text);
  if (command) down.commands = [command];
  return [
    ["Input.dispatchKeyEvent", down],
    ["Input.dispatchKeyEvent", keyParams("keyUp", spec, modifiers)],
  ];
}

/** Presses one chord ("ctrl+a", ["Control", "C"], "Return") `repeat` times,
 *  pressing modifiers first and releasing them last. */
export async function pressChord(
  send: CdpSend,
  sessionId: string,
  state: InputState,
  chord: string | string[],
  repeat = 1,
): Promise<void> {
  const parsed = parseChord(chord);
  const times = Math.min(Math.max(Math.trunc(repeat), 1), 100);
  const events: InputEvents = [];
  let mask = state.modifiers;
  const pressed: KeySpec[] = [];
  for (const m of parsed.modifiers) {
    if (mask & MODIFIER_BITS[m]) continue;
    const spec = keySpecFor(m);
    mask |= MODIFIER_BITS[m];
    events.push(["Input.dispatchKeyEvent", keyParams("rawKeyDown", spec, mask)]);
    pressed.push(spec);
  }
  if (parsed.key) {
    for (let i = 0; i < times; i++) events.push(...keyStrokeEvents(parsed.key, mask, state.macEditing));
  }
  for (const spec of pressed.reverse()) {
    mask &= ~MODIFIER_BITS[spec.key as ModifierKey];
    events.push(["Input.dispatchKeyEvent", keyParams("keyUp", spec, mask)]);
  }
  await dispatchAll(send, sessionId, events);
}

/** Presses each space-separated chord in turn: "ctrl+a Delete". */
export async function pressSequence(
  send: CdpSend,
  sessionId: string,
  state: InputState,
  sequence: string,
  repeat = 1,
): Promise<void> {
  const chords = sequence.trim() === "" ? [] : sequence.trim().split(/\s+/);
  if (chords.length === 0) throw new Error("no key given");
  for (const chord of chords) await pressChord(send, sessionId, state, chord, repeat);
}

export async function keyDown(send: CdpSend, sessionId: string, state: InputState, name: string): Promise<void> {
  const spec = keySpecFor(name);
  if (state.heldKeys.has(spec.key)) return;
  state.heldKeys.set(spec.key, spec);
  await send("Input.dispatchKeyEvent", keyParams(spec.text ? "keyDown" : "rawKeyDown", spec, state.modifiers), sessionId);
}

export async function keyUp(send: CdpSend, sessionId: string, state: InputState, name: string): Promise<void> {
  const spec = keySpecFor(name);
  if (!state.heldKeys.delete(spec.key)) return;
  await send("Input.dispatchKeyEvent", keyParams("keyUp", spec, state.modifiers), sessionId);
}

/** Releases every held mouse button and key so a failed or closing session
 *  never leaves the page with a stuck modifier or a drag in progress. */
export async function releaseAll(send: CdpSend, sessionId: string, state: InputState): Promise<void> {
  for (const button of ["left", "right", "middle"] as const) {
    if (state.buttons & BUTTON_BITS[button]) await mouseUp(send, sessionId, state, state.position, button);
  }
  for (const name of [...state.heldKeys.keys()].reverse()) await keyUp(send, sessionId, state, name);
}
