import { fnv1a } from "./hash.js";
import type { RefTable } from "./refs.js";
import { StaleRefError } from "./actions.js";
import { RESOLVE_FN, type PageResolveReply } from "./page-script.js";
import type { CdpSend } from "./types.js";

export type ExtractFormat = "text" | "markdown" | "links";

export interface ExtractOptions {
  format?: ExtractFormat;
  selector?: string;
  maxChars?: number;
}

export interface ExtractResult {
  format: ExtractFormat;
  text: string;
  truncated: boolean;
}

export interface ScreenshotOptions {
  ref?: string;
  fullPage?: boolean;
  quality?: number;
  skipIfUnchanged?: boolean;
}

export interface ScreenshotResult {
  base64?: string;
  bytes: number;
  format: "jpeg";
  unchanged: boolean;
}

const DEFAULT_MAX_CHARS = 8_000;
const DEFAULT_QUALITY = 60;

const READERS: Record<ExtractFormat, string> = {
  text: `(root) => (root.innerText ?? root.textContent ?? "").replace(/\\n{3,}/g, "\\n\\n").trim()`,
  links: `(root) => Array.from(root.querySelectorAll("a[href]"))
      .map((a) => [a.textContent.replace(/\\s+/g, " ").trim(), a.href])
      .filter(([label, href]) => label && !href.startsWith("javascript:"))
      .map(([label, href]) => label + " -> " + href)
      .join("\\n")`,
  markdown: `(root) => {
      const out = [];
      const walk = (node) => {
        if (node.nodeType === 3) {
          const t = node.textContent.replace(/\\s+/g, " ");
          if (t.trim()) out.push(t);
          return;
        }
        if (node.nodeType !== 1) return;
        const tag = node.tagName.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "noscript") return;
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return;
        if (/^h[1-6]$/.test(tag)) {
          out.push("\\n" + "#".repeat(Number(tag[1])) + " " + node.textContent.replace(/\\s+/g, " ").trim() + "\\n");
          return;
        }
        if (tag === "li") {
          out.push("\\n- " + node.textContent.replace(/\\s+/g, " ").trim());
          return;
        }
        if (tag === "a" && node.getAttribute("href")) {
          out.push("[" + node.textContent.replace(/\\s+/g, " ").trim() + "](" + node.href + ")");
          return;
        }
        if (tag === "p" || tag === "div" || tag === "section" || tag === "br") out.push("\\n");
        for (const child of node.childNodes) walk(child);
      };
      walk(root);
      return out.join(" ").replace(/[ \\t]{2,}/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim();
    }`,
};

/** Page content as plain text, markdown or a link list. Reading never needs refs. */
export async function extractContent(
  send: CdpSend,
  sessionId: string,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const format = opts.format ?? "markdown";
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const rootExpr = opts.selector ? `document.querySelector(${JSON.stringify(opts.selector)})` : "document.body";
  const expression = `(${READERS[format]})(${rootExpr} ?? document.body)`;

  const res = (await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string };
  };
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text ?? "extract failed");

  const full = typeof res.result?.value === "string" ? res.result.value : "";
  const truncated = full.length > maxChars;
  const text = truncated
    ? `${full.slice(0, maxChars)}\n... ${full.length - maxChars} more characters. Narrow with a selector or raise maxChars.`
    : full;
  return { format, text, truncated };
}

/** JPEG screenshot of the viewport, the full page, or one element. */
export async function captureScreenshot(
  send: CdpSend,
  sessionId: string,
  refs: RefTable,
  opts: ScreenshotOptions = {},
  previousHash?: string,
): Promise<{ result: ScreenshotResult; hash: string }> {
  const params: Record<string, unknown> = {
    format: "jpeg",
    quality: opts.quality ?? DEFAULT_QUALITY,
    captureBeyondViewport: opts.fullPage === true,
  };

  if (opts.ref) {
    if (!refs.get(opts.ref)) throw new StaleRefError(opts.ref, "Take a fresh snapshot and use the new refs.");
    const box = await refs.world.call<PageResolveReply>(send, sessionId, RESOLVE_FN, {
      ref: opts.ref,
      mode: "rect",
      deadlineMs: 0,
    });
    if (!box?.ok) throw new StaleRefError(opts.ref, "The element has no visible box. Take a fresh snapshot.");
    params.clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
  }

  const shot = (await send("Page.captureScreenshot", params, sessionId)) as { data?: string };
  const base64 = shot.data ?? "";
  const hash = fnv1a(base64).toString(16);
  if (opts.skipIfUnchanged && previousHash === hash) {
    return { result: { bytes: 0, format: "jpeg", unchanged: true }, hash };
  }
  return {
    result: { base64, bytes: Math.floor((base64.length * 3) / 4), format: "jpeg", unchanged: false },
    hash,
  };
}

