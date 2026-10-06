import { clickAt, InputState, mouseMove, pressChord, wheelAt, type MouseButton } from "./input.js";
import type { ModifierKey } from "./keys.js";
import { RESOLVE_FN, type PageResolveReply, type PageResolveRequest } from "./page-script.js";
import type { RefTable } from "./refs.js";
import type { CdpSend } from "./types.js";

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
  button?: MouseButton;
  clickCount?: number;
  modifiers?: ModifierKey[];
}

export interface ActionOptions {
  actionabilityTimeoutMs?: number;
  commandTimeoutMs?: number;
  input?: InputState;
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
  const input = opts.input ?? new InputState();
  if (step.type === "wait") {
    await delay(Math.min(Math.max(step.ms ?? 500, 0), MAX_WAIT_STEP_MS));
    return;
  }
  if (step.type === "scroll") {
    const amount = step.amount ?? 600;
    await wheelAt(send, sessionId, input, { x: 10, y: 10 }, 0, step.direction === "up" ? -amount : amount);
    return;
  }
  if (step.type === "press" && !step.ref) {
    await pressChord(send, sessionId, input, requireKey(step));
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
      await clickAt(send, sessionId, input, point, step);
      return;
    case "hover":
      await mouseMove(send, sessionId, input, point);
      return;
    case "check":
    case "uncheck":
      if ((resolved.checked === true) !== (step.type === "check")) await clickAt(send, sessionId, input, point);
      return;
    case "fill":
      await clickAt(send, sessionId, input, point);
      // Some pages swap an input for a new one when it is clicked; type into what now has focus.
      await resolve(send, sessionId, refs, { ref, mode: "focus-select", deadlineMs, acceptFocused: true });
      await send("Input.insertText", { text: step.text ?? "" }, sessionId);
      return;
    case "type":
      await clickAt(send, sessionId, input, point);
      await send("Input.insertText", { text: step.text ?? "" }, sessionId);
      return;
    case "press":
      await clickAt(send, sessionId, input, point);
      await pressChord(send, sessionId, input, requireKey(step));
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
