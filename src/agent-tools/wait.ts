import type { CdpSend } from "./snapshot.js";

export interface WaitCondition {
  text?: string;
  textGone?: string;
  selector?: string;
  selectorGone?: string;
  urlContains?: string;
  timeoutMs?: number;
}

export interface WaitResult {
  met: true;
  waitedMs: number;
}

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

/** Polls one page condition until it holds or the timeout expires. Throws with the
 *  condition and elapsed time so the agent can decide what to do next. */
export async function waitForCondition(
  send: CdpSend,
  sessionId: string,
  condition: WaitCondition,
): Promise<WaitResult> {
  const expression = conditionExpression(condition);
  const timeoutMs = condition.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const res = (await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)) as {
      result?: { value?: unknown };
    };
    if (res.result?.value === true) return { met: true, waitedMs: Date.now() - started };
    await delay(POLL_MS);
  }
  throw new Error(`waited ${timeoutMs}ms but ${describe(condition)} never happened`);
}

function conditionExpression(condition: WaitCondition): string {
  if (condition.text) return `document.body.innerText.includes(${JSON.stringify(condition.text)})`;
  if (condition.textGone) return `!document.body.innerText.includes(${JSON.stringify(condition.textGone)})`;
  if (condition.selector) return `!!document.querySelector(${JSON.stringify(condition.selector)})`;
  if (condition.selectorGone) return `!document.querySelector(${JSON.stringify(condition.selectorGone)})`;
  if (condition.urlContains) return `location.href.includes(${JSON.stringify(condition.urlContains)})`;
  throw new Error("wait needs one of text, textGone, selector, selectorGone or urlContains");
}

function describe(condition: WaitCondition): string {
  if (condition.text) return `text "${condition.text}" appearing`;
  if (condition.textGone) return `text "${condition.textGone}" disappearing`;
  if (condition.selector) return `selector "${condition.selector}" appearing`;
  if (condition.selectorGone) return `selector "${condition.selectorGone}" disappearing`;
  return `url containing "${condition.urlContains}"`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
