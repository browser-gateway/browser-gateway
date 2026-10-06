import { parseChord, type ModifierKey } from "../keys.js";
import type { Observation } from "./session.js";
import type { ImageBlock, TextBlock, ToolResultBlock, ToolUseBlock } from "./types.js";

/** An action the model asked for could not run; the message goes back to the model. */
export class MemberError extends Error {}

export function okResult(id: string, toolset: string | undefined, content: ToolResultBlock["content"]): ToolResultBlock {
  return toolset
    ? { type: "tool_result", tool_use_id: id, toolset_name: toolset, content }
    : { type: "tool_result", tool_use_id: id, content };
}

export function errorResult(id: string, toolset: string | undefined, message: string): ToolResultBlock {
  return { ...okResult(id, toolset, [{ type: "text", text: message }]), is_error: true };
}

export function textBlock(value: string): TextBlock {
  return { type: "text", text: value };
}

export function imageBlock(obs: Observation): ImageBlock {
  return { type: "image", source: { type: "base64", media_type: obs.mimeType, data: obs.base64 } };
}

/** Runs a turn's calls in order; after the first failure the rest get `haltText` and do not run. */
export async function runBatch(
  calls: ToolUseBlock[],
  toolset: string | undefined,
  haltText: string,
  runOne: (call: ToolUseBlock) => Promise<ToolResultBlock>,
): Promise<{ results: ToolResultBlock[]; failed: boolean }> {
  const results: ToolResultBlock[] = [];
  let failed = false;
  for (const call of calls) {
    if (failed) {
      results.push(errorResult(call.id, toolset, haltText));
      continue;
    }
    const result = await runOne(call);
    if (result.is_error) failed = true;
    results.push(result);
  }
  return { results, failed };
}

/** Modifier keys named in a chord such as "ctrl+shift" or "super". */
export function modifiersOf(chord: string): ModifierKey[] {
  const parsed = parseChord(chord);
  return parsed.key && ["Control", "Shift", "Alt", "Meta"].includes(parsed.key.key)
    ? [...parsed.modifiers, parsed.key.key as ModifierKey]
    : parsed.modifiers;
}

/** Every key in a chord, modifiers first, for holding them down. */
export function chordKeys(chord: string): string[] {
  const parsed = parseChord(chord);
  return [...parsed.modifiers, ...(parsed.key ? [parsed.key.key] : [])];
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(n, min), max);
}

export function clampSeconds(value: unknown, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.min(Math.max(n, 0), max);
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new MemberError(`${field} is required.`);
  return value;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const SCROLL_PX_PER_NOTCH = 100;
export const MAX_HOLD_S = 30;
