import type { ExtractFormat, ScreenshotResult } from "./read.js";
import type { AgentSession } from "./session.js";

export interface FetchPageOptions {
  url: string;
  format?: ExtractFormat;
  selector?: string;
  maxChars?: number;
  /** Wait for this text to appear before reading, for pages that fill in late. */
  waitForText?: string;
}

export interface FetchPageResult {
  url: string;
  title: string;
  format: ExtractFormat;
  text: string;
  truncated: boolean;
  waitTimedOut?: boolean;
  /** Set when the page looks like a block, bot check, login wall or error page instead of real content. */
  blocked?: string;
}

export interface ScreenshotPageOptions {
  url: string;
  fullPage?: boolean;
  quality?: number;
  waitForText?: string;
}

export interface ScreenshotPageResult {
  url: string;
  title: string;
  image: ScreenshotResult;
  waitTimedOut?: boolean;
  blocked?: string;
}

const FETCH_PAGE_MAX_CHARS = 20_000;
const BLOCK_PROBE_CHARS = 2_000;
const SHORT_PAGE_CHARS = 300;

const BLOCK_SIGNS: ReadonlyArray<[RegExp, string]> = [
  [/just a moment|checking your browser|attention required/i, "a bot check page"],
  [/verify (that )?you are (a )?human|are you a robot|press (&|and) hold|(complete|solve) the captcha/i, "a captcha"],
  [/access (is )?(temporarily )?(denied|restricted)|request (was )?blocked|unusual traffic|403 forbidden/i, "an access-denied page"],
  [/sign in to continue|log in to continue|you must (be )?(logged|signed) in/i, "a login wall"],
];

/** Names what a page that is not real content looks like, or returns undefined.
 *  A hint for the agent, never a decision: real pages can mention these words. */
export function detectBlockedPage(page: { url: string; title: string; text: string }): string | undefined {
  if (page.url.startsWith("chrome-error://")) return "the browser could not load the page";
  const head = `${page.title}\n${page.text.slice(0, BLOCK_PROBE_CHARS)}`;
  for (const [pattern, label] of BLOCK_SIGNS) {
    if (pattern.test(head)) return `the page looks like ${label}`;
  }
  if (page.text.trim().length < SHORT_PAGE_CHARS && /enable javascript|javascript is (disabled|required)/i.test(head)) {
    return "the page asks for JavaScript and showed almost no content";
  }
  return undefined;
}

async function load(agent: AgentSession, url: string, waitForText?: string) {
  const page = await agent.goto(url);
  if (!waitForText) return { ...page, waitTimedOut: undefined };
  try {
    await agent.waitFor({ text: waitForText });
    return { ...page, waitTimedOut: undefined };
  } catch {
    return { ...page, waitTimedOut: true as const };
  }
}

/** Loads a url in an open session and returns its content in one step. */
export async function fetchPage(agent: AgentSession, opts: FetchPageOptions): Promise<FetchPageResult> {
  const page = await load(agent, opts.url, opts.waitForText);
  const content = await agent.extract({
    format: opts.format ?? "markdown",
    selector: opts.selector,
    maxChars: opts.maxChars ?? FETCH_PAGE_MAX_CHARS,
  });
  const blocked = detectBlockedPage({ url: page.url, title: page.title, text: content.text });
  return {
    url: page.url,
    title: page.title,
    format: content.format,
    text: content.text,
    truncated: content.truncated,
    ...(page.waitTimedOut ? { waitTimedOut: true } : {}),
    ...(blocked ? { blocked } : {}),
  };
}

/** Loads a url in an open session and screenshots it in one step. */
export async function screenshotPage(agent: AgentSession, opts: ScreenshotPageOptions): Promise<ScreenshotPageResult> {
  const page = await load(agent, opts.url, opts.waitForText);
  const image = await agent.screenshot({ fullPage: opts.fullPage, quality: opts.quality });
  const probe = await agent.extract({ format: "text", maxChars: BLOCK_PROBE_CHARS });
  const blocked = detectBlockedPage({ url: page.url, title: page.title, text: probe.text });
  return {
    url: page.url,
    title: page.title,
    image,
    ...(page.waitTimedOut ? { waitTimedOut: true } : {}),
    ...(blocked ? { blocked } : {}),
  };
}
