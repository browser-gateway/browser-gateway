import { QUIET_FN, WAIT_FN, type PageQuietRequest, type PageWaitRequest } from "./page-script.js";
import type { RefTable } from "./refs.js";
import type { CdpSend } from "./types.js";

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
const MAX_WAIT_TIMEOUT_MS = 60_000;
const QUIET_MS = 100;

/** Bounds a caller-supplied wait to `MAX_WAIT_TIMEOUT_MS`.
 *
 *  The wait holds an open evaluate for the whole window, so an unbounded value
 *  would hold a browser and its provider slot indefinitely. Non-numeric input
 *  falls back to the default rather than throwing.
 */
export function clampWaitTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(Math.max(requested, 0), MAX_WAIT_TIMEOUT_MS);
}

/** Waits for one page condition in a single round trip: a mutation observer in the
 *  page resolves the promise, so settle time costs no extra traffic. Throws with the
 *  condition and elapsed time so the agent can decide what to do next. */
export async function waitForCondition(
  send: CdpSend,
  sessionId: string,
  refs: RefTable,
  condition: WaitCondition,
): Promise<WaitResult> {
  const timeoutMs = clampWaitTimeout(condition.timeoutMs);
  const request: PageWaitRequest = { ...pick(condition), timeoutMs };
  const reply = await refs.world.call<{ met?: boolean; waitedMs?: number }>(send, sessionId, WAIT_FN, request);
  if (reply?.met !== true) throw new Error(`waited ${timeoutMs}ms but ${describe(condition)} never happened`);
  return { met: true, waitedMs: reply.waitedMs ?? 0 };
}

/** Blocks until the page stops mutating, capped at `maxMs`. One round trip. */
export async function waitForQuiet(
  send: CdpSend,
  sessionId: string,
  refs: RefTable,
  maxMs: number,
): Promise<void> {
  const request: PageQuietRequest = { quietMs: Math.min(QUIET_MS, maxMs), maxMs };
  await refs.world.call<number>(send, sessionId, QUIET_FN, request);
}

function pick(condition: WaitCondition): Omit<PageWaitRequest, "timeoutMs"> {
  if (condition.text !== undefined) return { kind: "text", value: condition.text };
  if (condition.textGone !== undefined) return { kind: "textGone", value: condition.textGone };
  if (condition.selector !== undefined) return { kind: "selector", value: condition.selector };
  if (condition.selectorGone !== undefined) return { kind: "selectorGone", value: condition.selectorGone };
  if (condition.urlContains !== undefined) return { kind: "urlContains", value: condition.urlContains };
  throw new Error("wait needs one of text, textGone, selector, selectorGone or urlContains");
}

function describe(condition: WaitCondition): string {
  if (condition.text) return `text "${condition.text}" appearing`;
  if (condition.textGone) return `text "${condition.textGone}" disappearing`;
  if (condition.selector) return `selector "${condition.selector}" appearing`;
  if (condition.selectorGone) return `selector "${condition.selectorGone}" disappearing`;
  return `url containing "${condition.urlContains}"`;
}
