import { boxOfQuad } from "./geometry.js";
import type { RefTable } from "./refs.js";

export type CdpSend = (
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
) => Promise<unknown>;

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
  "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio",
  "slider", "spinbutton", "switch", "tab", "textarea",
]);

const CONTEXT_ROLES = new Set([
  "heading", "dialog", "alert", "alertdialog", "form", "navigation", "main", "table",
]);

const MAX_NAME_CHARS = 120;

export interface SnapshotOptions {
  scope?: "viewport" | "full";
  interactiveOnly?: boolean;
  maxLines?: number;
  sinceLast?: boolean;
}

export interface SnapshotResult {
  text: string;
  lineCount: number;
  truncated: boolean;
  unchanged: boolean;
}

interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
  backendDOMNodeId?: number;
}

interface Viewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

export async function buildSnapshot(
  send: CdpSend,
  sessionId: string,
  refs: RefTable,
  opts: SnapshotOptions = {},
  previous?: string,
): Promise<SnapshotResult> {
  const interactiveOnly = opts.interactiveOnly ?? true;
  const scope = opts.scope ?? "viewport";
  const maxLines = opts.maxLines ?? 200;

  const tree = (await send("Accessibility.getFullAXTree", {}, sessionId)) as { nodes?: AxNode[] };
  const nodes = tree.nodes ?? [];
  const viewport = scope === "viewport" ? await readViewport(send, sessionId) : null;

  refs.clear();
  const lines: string[] = [];
  let skipped = 0;

  for (const node of nodes) {
    if (node.ignored) continue;
    const role = node.role?.value ?? "";
    const interactive = INTERACTIVE_ROLES.has(role);
    if (!interactive && (interactiveOnly || !CONTEXT_ROLES.has(role))) continue;
    if (node.backendDOMNodeId === undefined) continue;

    if (viewport && !(await isInViewport(send, sessionId, node.backendDOMNodeId, viewport))) {
      skipped++;
      continue;
    }

    const name = clip(node.name?.value ?? "");
    if (interactive) {
      const ref = refs.add({ backendNodeId: node.backendDOMNodeId, role, name });
      lines.push(`${ref} ${role}${name ? ` "${name}"` : ""}${describeState(node)}`);
    } else {
      lines.push(`- ${role}${name ? ` "${name}"` : ""}`);
    }
  }

  const truncated = lines.length > maxLines;
  const shown = truncated ? lines.slice(0, maxLines) : lines;
  if (truncated) {
    shown.push(
      `... ${lines.length - maxLines} more elements. Narrow with scope:"viewport", a selector, or a higher maxLines.`,
    );
  }
  if (skipped > 0) shown.push(`... ${skipped} elements outside the viewport. Use scope:"full" to include them.`);

  const text = shown.join("\n");
  if (opts.sinceLast && previous !== undefined && previous === text) {
    return { text: "unchanged since last snapshot", lineCount: 0, truncated: false, unchanged: true };
  }
  return { text, lineCount: shown.length, truncated, unchanged: false };
}

function clip(name: string): string {
  const flat = name.replace(/\s+/g, " ").trim();
  return flat.length > MAX_NAME_CHARS ? `${flat.slice(0, MAX_NAME_CHARS)}…` : flat;
}

function describeState(node: AxNode): string {
  const parts: string[] = [];
  const value = node.value?.value;
  if (typeof value === "string" && value !== "") parts.push(`value="${clip(value)}"`);
  for (const p of node.properties ?? []) {
    if (p.name === "checked" && p.value?.value !== undefined) parts.push(`checked=${String(p.value.value)}`);
    if (p.name === "disabled" && p.value?.value === true) parts.push("disabled");
    if (p.name === "expanded" && p.value?.value !== undefined) parts.push(`expanded=${String(p.value.value)}`);
    if (p.name === "required" && p.value?.value === true) parts.push("required");
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

async function readViewport(send: CdpSend, sessionId: string): Promise<Viewport | null> {
  try {
    const metrics = (await send("Page.getLayoutMetrics", {}, sessionId)) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number };
    };
    const v = metrics.cssVisualViewport;
    if (!v?.clientWidth || !v.clientHeight) return null;
    return {
      width: v.clientWidth,
      height: v.clientHeight,
      scrollX: v.pageX ?? 0,
      scrollY: v.pageY ?? 0,
    };
  } catch {
    return null;
  }
}

async function isInViewport(
  send: CdpSend,
  sessionId: string,
  backendNodeId: number,
  viewport: Viewport,
): Promise<boolean> {
  try {
    const res = (await send("DOM.getBoxModel", { backendNodeId }, sessionId)) as { model?: { content?: number[] } };
    const box = boxOfQuad(res.model?.content);
    if (!box) return true;
    if (box.right <= 0 || box.bottom <= 0) return false;
    return box.top <= viewport.scrollY + viewport.height && box.left <= viewport.scrollX + viewport.width;
  } catch {
    return true;
  }
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  text: string;
}

/** Line-level difference between two snapshots, for post-action results. */
export function diffSnapshots(previous: string | undefined, next: string): SnapshotDiff {
  if (previous === undefined) return { added: [], removed: [], text: next };
  const before = new Set(previous.split("\n"));
  const after = new Set(next.split("\n"));
  const added = [...after].filter((line) => !before.has(line));
  const removed = [...before].filter((line) => !after.has(line));
  if (added.length === 0 && removed.length === 0) return { added, removed, text: "no visible change" };
  const parts: string[] = [];
  if (added.length > 0) parts.push(added.map((l) => `+ ${l}`).join("\n"));
  if (removed.length > 0) parts.push(removed.map((l) => `- ${l}`).join("\n"));
  return { added, removed, text: parts.join("\n") };
}
