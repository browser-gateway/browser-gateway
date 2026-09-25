import { keySpecFor } from "./keys.js";
import { RESOLVE_FN, type PageResolveReply, type PageResolveRequest } from "./page-script.js";
import type { RefTable } from "./refs.js";
import type { CdpSend, Point } from "./types.js";

export type ActionType =
  | "click"
  | "fill"
  | "type"
  | "press"
  | "hover"
  | "check"
  | "uncheck"
  | "select"
  | "scroll"
  | "wait";

export interface ActionStep {
  type: ActionType;
  ref?: string;
  text?: string;
  key?: string;
  direction?: "up" | "down";
  amount?: number;
  ms?: number;
}

export interface ActionOptions {
  actionabilityTimeoutMs?: number;
  commandTimeoutMs?: number;
}

export class StaleRefError extends Error {
  constructor(
    readonly ref: string,
    readonly hint: string,
  ) {
    super(`${ref} is no longer on the page. ${hint}`);
    this.name = "StaleRefError";
  }
}

export class NotActionableError extends Error {
  constructor(
    readonly ref: string,
    reason: string,
  ) {
    super(`${ref} is not actionable: ${reason}`);
    this.name = "NotActionableError";
  }
}

const DEFAULT_ACTIONABILITY_TIMEOUT_MS = 5_000;
const MAX_WAIT_STEP_MS = 10_000;
const REF_STEPS = new Set<string>(["click", "fill", "type", "press", "hover", "check", "uncheck", "select"]);

/** Performs one agent action with real input events. Resolves the element, its
 *  geometry and its actionability in a single page call, then dispatches input.
 *  Throws {@link StaleRefError} when the ref no longer resolves and
 *  {@link NotActionableError} when it never settles. */
export async function performAction(
  send: CdpSend,
  sessionId: string,
  refs: RefTable,
  step: ActionStep,
  opts: ActionOptions = {},
): Promise<void> {
  if (step.type === "wait") {
    await delay(Math.min(Math.max(step.ms ?? 500, 0), MAX_WAIT_STEP_MS));
    return;
  }
  if (step.type === "scroll") {
    await scroll(send, sessionId, step.direction ?? "down", step.amount ?? 600);
    return;
  }
  if (step.type === "press" && !step.ref) {
    await pressKey(send, sessionId, requireKey(step));
    return;
  }

  if (!REF_STEPS.has(step.type)) {
    throw new Error(
      `unknown step type "${step.type}". Supported: ${[...REF_STEPS, "scroll", "wait"].join(", ")}.`,
    );
  }

  const ref = step.ref;
  if (!ref) throw new Error(`${step.type} needs a ref from a snapshot, e.g. e4`);
  if (!refs.get(ref)) throw new StaleRefError(ref, "Take a fresh snapshot and use the new refs.");

  const deadlineMs = opts.actionabilityTimeoutMs ?? DEFAULT_ACTIONABILITY_TIMEOUT_MS;

  if (step.type === "select") {
    await resolve(send, sessionId, refs, { ref, mode: "select", deadlineMs, option: step.text ?? "" });
    return;
  }

  const resolved = await resolve(send, sessionId, refs, { ref, mode: "point", deadlineMs });
  const point = { x: resolved.x ?? 0, y: resolved.y ?? 0 };

  switch (step.type) {
    case "click":
      await click(send, sessionId, point);
      return;
    case "hover":
      await mouseMove(send, sessionId, point);
      return;
    case "check":
    case "uncheck":
      if ((resolved.checked === true) !== (step.type === "check")) await click(send, sessionId, point);
      return;
    case "fill":
      await click(send, sessionId, point);
      // Some pages swap an input for a new one when it is clicked; type into what now has focus.
      await resolve(send, sessionId, refs, { ref, mode: "focus-select", deadlineMs, acceptFocused: true });
      await send("Input.insertText", { text: step.text ?? "" }, sessionId);
      return;
    case "type":
      await click(send, sessionId, point);
      await send("Input.insertText", { text: step.text ?? "" }, sessionId);
      return;
    case "press":
      await click(send, sessionId, point);
      await pressKey(send, sessionId, requireKey(step));
      return;
    default:
      throw new Error(`unsupported action ${String(step.type)}`);
  }
}

async function resolve(
  send: CdpSend,
  sessionId: string,
  refs: RefTable,
  request: PageResolveRequest,
): Promise<PageResolveReply> {
  const reply = await refs.world.call<PageResolveReply>(send, sessionId, RESOLVE_FN, request);
  if (!reply || reply.stale) {
    throw new StaleRefError(request.ref, "The page changed. Take a fresh snapshot and use the new refs.");
  }
  if (!reply.ok) throw new NotActionableError(request.ref, reply.reason ?? "never became visible");
  return reply;
}

function requireKey(step: ActionStep): string {
  if (!step.key) throw new Error("press needs a key");
  return step.key;
}

/** Input events for one gesture are written back to back without awaiting each in
 *  turn: the browser processes them in arrival order, so the gesture costs one
 *  round trip instead of one per event. */
function dispatchAll(send: CdpSend, sessionId: string, events: Array<[string, Record<string, unknown>]>) {
  return Promise.all(events.map(([method, params]) => send(method, params, sessionId)));
}

async function click(send: CdpSend, sessionId: string, point: Point): Promise<void> {
  const base = { x: point.x, y: point.y, button: "left", clickCount: 1, buttons: 1 };
  await dispatchAll(send, sessionId, [
    ["Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, buttons: 0 }],
    ["Input.dispatchMouseEvent", { ...base, type: "mousePressed" }],
    ["Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 }],
  ]);
}

async function mouseMove(send: CdpSend, sessionId: string, point: Point): Promise<void> {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, buttons: 0 }, sessionId);
}

async function scroll(send: CdpSend, sessionId: string, direction: "up" | "down", amount: number): Promise<void> {
  await send(
    "Input.dispatchMouseEvent",
    { type: "mouseWheel", x: 10, y: 10, deltaX: 0, deltaY: direction === "down" ? amount : -amount },
    sessionId,
  );
}

async function pressKey(send: CdpSend, sessionId: string, key: string): Promise<void> {
  const spec = keySpecFor(key);
  const common = { key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode };
  const text = spec.text ?? (key.length === 1 ? key : undefined);
  const events: Array<[string, Record<string, unknown>]> = [
    ["Input.dispatchKeyEvent", { ...common, type: spec.text ? "keyDown" : "rawKeyDown" }],
  ];
  if (text !== undefined) events.push(["Input.dispatchKeyEvent", { ...common, type: "char", text }]);
  events.push(["Input.dispatchKeyEvent", { ...common, type: "keyUp" }]);
  await dispatchAll(send, sessionId, events);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
