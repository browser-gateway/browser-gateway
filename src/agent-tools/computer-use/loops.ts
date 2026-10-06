import type { AnthropicBrowserExecutor } from "./anthropic-browser.js";
import type { AnthropicComputerExecutor } from "./anthropic-computer.js";
import type { GeminiExecutor, GeminiFunctionResponsePart } from "./gemini.js";
import { pruneImages } from "./prune.js";

const DEFAULT_MAX_TURNS = 30;
const DEFAULT_KEEP_IMAGES = 3;

export interface LoopResult<T> {
  /** The model's final text answer, empty if it never gave one. */
  text: string;
  turns: number;
  /** Why the loop ended. */
  stoppedBy: "done" | "max-turns" | "declined";
  /** The whole conversation, for logging or continuing it. */
  transcript: T[];
}

export interface ClaudeLoopOptions {
  executor: AnthropicBrowserExecutor | AnthropicComputerExecutor;
  /** Calls the Messages API with your model and settings; we supply `tools` and `messages`. */
  createMessage: (request: { tools: unknown[]; messages: unknown[] }) => Promise<{ content: unknown[]; stop_reason?: string }>;
  task: string;
  maxTurns?: number;
  /** Screenshots kept in the conversation sent to the model. Default 3. */
  keepImages?: number;
}

/** Asks Claude, runs its browser actions, sends back the results, and repeats
 *  until Claude answers or `maxTurns` is reached. */
export async function runClaudeLoop(opts: ClaudeLoopOptions): Promise<LoopResult<{ role: string; content: unknown }>> {
  const messages: Array<{ role: string; content: unknown }> = [{ role: "user", content: opts.task }];
  const tools = [opts.executor.declaration()];
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  for (let turn = 1; turn <= maxTurns; turn++) {
    const response = await opts.createMessage({ tools, messages: pruneImages(messages, opts.keepImages ?? DEFAULT_KEEP_IMAGES) });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return { text: textOf(response.content), turns: turn, stoppedBy: "done", transcript: messages };
    }
    messages.push({ role: "user", content: await opts.executor.run(response.content) });
  }
  return { text: "", turns: maxTurns, stoppedBy: "max-turns", transcript: messages };
}

interface GeminiContent {
  role: string;
  parts: unknown[];
}

export interface GeminiLoopOptions {
  executor: GeminiExecutor;
  /** Calls `models/<model>:generateContent` with your model; we supply `contents` and `tools`. */
  generateContent: (request: { contents: GeminiContent[]; tools: unknown[] }) => Promise<{ candidates?: Array<{ content?: GeminiContent }> }>;
  task: string;
  maxTurns?: number;
  keepImages?: number;
}

/** The generateContent form of the computer-use tool declaration. */
export const GEMINI_GENERATE_TOOLS = [{ computerUse: { environment: "ENVIRONMENT_BROWSER" } }];

/** Sends the task with a first screenshot, runs Gemini's actions, sends back the
 *  results, and repeats until Gemini answers, a person declines a confirmation,
 *  or `maxTurns` is reached. */
export async function runGeminiLoop(opts: GeminiLoopOptions): Promise<LoopResult<GeminiContent>> {
  const first = await opts.executor.initialObservation();
  const contents: GeminiContent[] = [
    { role: "user", parts: [{ text: opts.task }, { inlineData: { mimeType: first.mimeType, data: first.base64 } }] },
  ];
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  for (let turn = 1; turn <= maxTurns; turn++) {
    const response = await opts.generateContent({ contents: pruneImages(contents, opts.keepImages ?? DEFAULT_KEEP_IMAGES), tools: GEMINI_GENERATE_TOOLS });
    const content = response.candidates?.[0]?.content ?? { role: "model", parts: [] };
    contents.push(content);
    const calls = content.parts.filter((p) => typeof p === "object" && p !== null && "functionCall" in p);
    if (calls.length === 0) {
      return { text: textOf(content.parts), turns: turn, stoppedBy: "done", transcript: contents };
    }
    const { results, terminated } = await opts.executor.run(content.parts);
    if (results.length > 0) contents.push({ role: "user", parts: results as GeminiFunctionResponsePart[] });
    if (terminated) return { text: "", turns: turn, stoppedBy: "declined", transcript: contents };
  }
  return { text: "", turns: maxTurns, stoppedBy: "max-turns", transcript: contents };
}

function textOf(blocks: unknown[]): string {
  return blocks
    .map((b) => (b as { text?: unknown }).text)
    .filter((t): t is string => typeof t === "string")
    .join(" ")
    .trim();
}
