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

export interface ScreenshotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotOptions {
  ref?: string;
  fullPage?: boolean;
  quality?: number;
  skipIfUnchanged?: boolean;
  /** Default jpeg. */
  format?: "jpeg" | "png";
  /** Part of the viewport to capture, in CSS pixels relative to the visible area. */
  region?: ScreenshotRegion;
  /** Output pixels per CSS pixel. 0.5 halves the image; 2 doubles a zoomed region. */
  scale?: number;
}

export interface ScreenshotResult {
  base64?: string;
  bytes: number;
  format: "jpeg" | "png";
  unchanged: boolean;
  /** Image size in pixels; known for png. */
  width?: number;
  height?: number;
}

export interface ViewportMetrics {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
}

const METRICS_EXPRESSION = "({ width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio })";

/** Visible area size and scroll offset in CSS pixels, plus the device pixel ratio. */
export async function readViewportMetrics(send: CdpSend, sessionId: string): Promise<ViewportMetrics> {
  const res = (await send("Runtime.evaluate", { expression: METRICS_EXPRESSION, returnByValue: true }, sessionId)) as {
    result?: { value?: ViewportMetrics };
  };
  const v = res.result?.value;
  if (!v) throw new Error("could not read the page's viewport size");
  return v;
}

/** Width and height from a base64 PNG header, without decoding the image. */
export function pngSize(base64: string): { width: number; height: number } | null {
  if (!base64.startsWith("iVBORw0KGgo")) return null;
  const head = atob(base64.slice(0, 32));
  const at = (i: number) => head.charCodeAt(i);
  const read = (i: number) => ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0;
  return { width: read(16), height: read(20) };
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
  const format = opts.format ?? "jpeg";
  const params: Record<string, unknown> = { format, captureBeyondViewport: opts.fullPage === true };
  if (format === "jpeg") params.quality = opts.quality ?? DEFAULT_QUALITY;

  if (opts.ref) {
    if (!refs.get(opts.ref)) throw new StaleRefError(opts.ref, "Take a fresh snapshot and use the new refs.");
    const box = await refs.world.call<PageResolveReply>(send, sessionId, RESOLVE_FN, {
      ref: opts.ref,
      mode: "rect",
      deadlineMs: 0,
    });
    if (!box?.ok) throw new StaleRefError(opts.ref, "The element has no visible box. Take a fresh snapshot.");
    params.clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
  } else if (opts.region || opts.scale !== undefined) {
    // clip is measured from the top of the document, not the visible area.
    const m = await readViewportMetrics(send, sessionId);
    const r = opts.region ?? { x: 0, y: 0, width: m.width, height: m.height };
    params.clip = {
      x: r.x + m.scrollX,
      y: r.y + m.scrollY,
      width: r.width,
      height: r.height,
      scale: (opts.scale ?? 1) / m.devicePixelRatio,
    };
  }

  const shot = (await send("Page.captureScreenshot", params, sessionId)) as { data?: string };
  const base64 = shot.data ?? "";
  const hash = fnv1a(base64).toString(16);
  if (opts.skipIfUnchanged && previousHash === hash) {
    return { result: { bytes: 0, format, unchanged: true }, hash };
  }
  const size = format === "png" ? pngSize(base64) : null;
  return {
    result: { base64, bytes: Math.floor((base64.length * 3) / 4), format, unchanged: false, ...(size ?? {}) },
    hash,
  };
}

