import { boxOfQuad, centerOfBox, type Point } from "./geometry.js";
import { keySpecFor } from "./keys.js";
import type { RefEntry, RefTable } from "./refs.js";
import type { CdpSend } from "./snapshot.js";

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
const STABLE_POLL_MS = 50;
const MAX_WAIT_STEP_MS = 10_000;
const REF_STEPS = new Set<string>(["click", "fill", "type", "press", "hover", "check", "uncheck", "select"]);


/** Performs one agent action with real input events. Waits for the element to be
 *  visible, enabled and stable first; throws {@link StaleRefError} when the ref
 *  no longer resolves and {@link NotActionableError} when it never settles. */
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
  const entry = refs.get(ref);
  if (!entry) throw new StaleRefError(ref, "Take a fresh snapshot and use the new refs.");

  const nodeId = await resolveNode(send, sessionId, entry, ref);
  const point = await waitUntilActionable(send, sessionId, entry, ref, opts);

  switch (step.type) {
    case "click":
      await click(send, sessionId, point);
      return;
    case "hover":
      await mouseMove(send, sessionId, point);
      return;
    case "check":
    case "uncheck": {
      const checked = await readChecked(send, sessionId, nodeId);
      if (checked !== (step.type === "check")) await click(send, sessionId, point);
      return;
    }
    case "fill":
      await click(send, sessionId, point);
      await selectExistingText(send, sessionId, nodeId);
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
    case "select":
      await selectOption(send, sessionId, nodeId, step.text ?? "");
      return;
    default:
      throw new Error(`unsupported action ${String(step.type)}`);
  }
}

function requireKey(step: ActionStep): string {
  if (!step.key) throw new Error("press needs a key");
  return step.key;
}

async function resolveNode(send: CdpSend, sessionId: string, entry: RefEntry, ref: string): Promise<number> {
  try {
    const res = (await send("DOM.resolveNode", { backendNodeId: entry.backendNodeId }, sessionId)) as {
      object?: { objectId?: string };
    };
    if (!res.object?.objectId) throw new Error("no objectId");
    return entry.backendNodeId;
  } catch {
    throw new StaleRefError(ref, "The page changed. Take a fresh snapshot and use the new refs.");
  }
}

async function waitUntilActionable(
  send: CdpSend,
  sessionId: string,
  entry: RefEntry,
  ref: string,
  opts: ActionOptions,
): Promise<Point> {
  const deadline = Date.now() + (opts.actionabilityTimeoutMs ?? DEFAULT_ACTIONABILITY_TIMEOUT_MS);
  let lastReason = "never became visible";
  let previous: Point | null = null;

  while (Date.now() < deadline) {
    try {
      await send("DOM.scrollIntoViewIfNeeded", { backendNodeId: entry.backendNodeId }, sessionId);
    } catch {
      /* not scrollable (detached or display:none) — the box check below decides */
    }
    const point = await centerPoint(send, sessionId, entry.backendNodeId);
    if (!point) {
      lastReason = "has no visible box";
    } else if (previous && Math.abs(previous.x - point.x) < 1 && Math.abs(previous.y - point.y) < 1) {
      if (await isDisabled(send, sessionId, entry.backendNodeId)) {
        lastReason = "is disabled";
      } else {
        return point;
      }
    } else {
      lastReason = "kept moving";
    }
    previous = point;
    await delay(STABLE_POLL_MS);
  }
  throw new NotActionableError(ref, lastReason);
}

async function centerPoint(send: CdpSend, sessionId: string, backendNodeId: number): Promise<Point | null> {
  try {
    const res = (await send("DOM.getBoxModel", { backendNodeId }, sessionId)) as { model?: { content?: number[] } };
    const box = boxOfQuad(res.model?.content);
    if (!box || box.right - box.left <= 0 || box.bottom - box.top <= 0) return null;
    return centerOfBox(box);
  } catch {
    return null;
  }
}

async function isDisabled(send: CdpSend, sessionId: string, backendNodeId: number): Promise<boolean> {
  const value = await callOnNode<boolean>(
    send,
    sessionId,
    backendNodeId,
    "function() { return this.disabled === true || this.getAttribute('aria-disabled') === 'true'; }",
  );
  return value === true;
}

async function readChecked(send: CdpSend, sessionId: string, backendNodeId: number): Promise<boolean> {
  const value = await callOnNode<boolean>(
    send,
    sessionId,
    backendNodeId,
    "function() { return this.checked === true || this.getAttribute('aria-checked') === 'true'; }",
  );
  return value === true;
}

async function selectOption(send: CdpSend, sessionId: string, backendNodeId: number, label: string): Promise<void> {
  const ok = await callOnNode<boolean>(
    send,
    sessionId,
    backendNodeId,
    `function(wanted) {
      const options = Array.from(this.options ?? []);
      const match = options.find((o) => o.value === wanted || o.label === wanted || o.textContent.trim() === wanted);
      if (!match) return false;
      this.value = match.value;
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }`,
    [{ value: label }],
  );
  if (ok !== true) throw new Error(`no option matching "${label}"`);
}

async function callOnNode<T>(
  send: CdpSend,
  sessionId: string,
  backendNodeId: number,
  functionDeclaration: string,
  args: Array<{ value: unknown }> = [],
): Promise<T | undefined> {
  const resolved = (await send("DOM.resolveNode", { backendNodeId }, sessionId)) as {
    object?: { objectId?: string };
  };
  const objectId = resolved.object?.objectId;
  if (!objectId) return undefined;
  const res = (await send(
    "Runtime.callFunctionOn",
    { objectId, functionDeclaration, arguments: args, returnByValue: true },
    sessionId,
  )) as { result?: { value?: unknown } };
  return res.result?.value as T | undefined;
}

async function click(send: CdpSend, sessionId: string, point: Point): Promise<void> {
  await mouseMove(send, sessionId, point);
  const base = { x: point.x, y: point.y, button: "left", clickCount: 1, buttons: 1 };
  await send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" }, sessionId);
  await send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 }, sessionId);
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

async function selectExistingText(send: CdpSend, sessionId: string, backendNodeId: number): Promise<void> {
  await callOnNode(
    send,
    sessionId,
    backendNodeId,
    `function() {
      this.focus();
      if (typeof this.select === "function") { this.select(); return true; }
      const range = document.createRange();
      range.selectNodeContents(this);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }`,
  );
}

async function pressKey(send: CdpSend, sessionId: string, key: string): Promise<void> {
  const spec = keySpecFor(key);
  const common = { key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode };
  await send("Input.dispatchKeyEvent", { ...common, type: spec.text ? "keyDown" : "rawKeyDown" }, sessionId);
  if (spec.text) await send("Input.dispatchKeyEvent", { ...common, type: "char", text: spec.text }, sessionId);
  else if (key.length === 1) await send("Input.dispatchKeyEvent", { ...common, type: "char", text: key }, sessionId);
  await send("Input.dispatchKeyEvent", { ...common, type: "keyUp" }, sessionId);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
