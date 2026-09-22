import type { RefEntry, RefTable } from "./refs.js";
import { SNAPSHOT_FN, type PageSnapshotReply, type PageSnapshotRequest } from "./page-script.js";
import type { CdpSend } from "./types.js";

export type { CdpSend } from "./types.js";

const MAX_NODES = 10_000;

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

/** Reads the page in one round trip: a single script walks the DOM in an isolated
 *  world and returns finished, distilled lines with their element refs. */
export async function buildSnapshot(
  send: CdpSend,
  sessionId: string,
  refs: RefTable,
  opts: SnapshotOptions = {},
  previous?: string,
): Promise<SnapshotResult> {
  const maxLines = opts.maxLines ?? 200;
  const request: PageSnapshotRequest = {
    interactiveOnly: opts.interactiveOnly ?? true,
    viewportOnly: (opts.scope ?? "viewport") === "viewport",
    maxNodes: MAX_NODES,
  };

  const reply = await refs.world.call<PageSnapshotReply>(send, sessionId, SNAPSHOT_FN, request);
  const lines = reply?.lines ?? [];
  refs.lastUrl = reply?.url;
  refs.replaceAll(
    (reply?.refs ?? []).map(([ref, role, name]) => [ref, { role, name } satisfies RefEntry] as [string, RefEntry]),
  );

  const truncated = lines.length > maxLines;
  const shown = truncated ? lines.slice(0, maxLines) : [...lines];
  if (truncated) {
    shown.push(
      `... ${lines.length - maxLines} more elements. Narrow with scope:"viewport", a selector, or a higher maxLines.`,
    );
  }
  if (reply?.outsideViewport) {
    shown.push(`... ${reply.outsideViewport} elements outside the viewport. Use scope:"full" to include them.`);
  }
  if (reply?.capped) {
    shown.push(`... the page is too large to read in full. Narrow with a selector or read a smaller region.`);
  }

  const text = shown.join("\n");
  if (opts.sinceLast && previous !== undefined && previous === text) {
    return { text: "unchanged since last snapshot", lineCount: 0, truncated: false, unchanged: true };
  }
  return { text, lineCount: shown.length, truncated, unchanged: false };
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
