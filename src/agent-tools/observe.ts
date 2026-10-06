import type { CdpSend } from "./snapshot.js";

export type DialogPolicy = "accept" | "dismiss";

export interface ObservedDialog {
  type: string;
  message: string;
  handledWith: DialogPolicy;
  atMs: number;
}

export interface ObservedConsole {
  seq: number;
  level: string;
  text: string;
  atMs: number;
}

export interface ObservedRequest {
  seq: number;
  method: string;
  /** Origin and path only; query strings often carry tokens. */
  url: string;
  type?: string;
  status?: number;
  failed?: string;
  atMs: number;
}

export interface ObservedRequestFailure {
  url: string;
  errorText: string;
  atMs: number;
}

export interface ObservedDownload {
  id?: string;
  url: string;
  fileName: string;
  state: "started" | "completed" | "failed";
  atMs: number;
}

export interface ObservationSnapshot {
  console: ObservedConsole[];
  failedRequests: ObservedRequestFailure[];
  downloads: ObservedDownload[];
  dialogs: ObservedDialog[];
  newTabUrls: string[];
}

const DEFAULT_LIMIT = 50;
const REQUEST_LIMIT_FACTOR = 4;

/** Origin and path of a URL; the query string and fragment are dropped. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol === "data:" || u.protocol === "blob:") return `${u.protocol}...`;
    return `${u.origin}${u.pathname}${u.search ? "?..." : ""}`;
  } catch {
    return raw.split("?")[0] ?? raw;
  }
}

/** Per-session ring buffers for console output, failed requests, downloads,
 *  dialogs and popup tabs. Dialogs are answered automatically so an unanswered
 *  prompt can never freeze the page. */
export class Observations {
  readonly console: ObservedConsole[] = [];
  readonly failedRequests: ObservedRequestFailure[] = [];
  readonly downloads: ObservedDownload[] = [];
  readonly dialogs: ObservedDialog[] = [];
  readonly newTabUrls: string[] = [];
  readonly requests: ObservedRequest[] = [];
  private readonly requestsById = new Map<string, ObservedRequest>();
  private seq = 0;

  constructor(
    private readonly limit = DEFAULT_LIMIT,
    public dialogPolicy: DialogPolicy = "dismiss",
  ) {}

  recordConsole(level: string, text: string): void {
    push(this.console, { seq: ++this.seq, level, text: text.slice(0, 500), atMs: Date.now() }, this.limit);
  }

  recordFailedRequest(url: string, errorText: string): void {
    push(this.failedRequests, { url, errorText, atMs: Date.now() }, this.limit);
  }

  recordDownload(url: string, fileName: string, id?: string): void {
    push(this.downloads, { id, url, fileName, state: "started", atMs: Date.now() }, this.limit);
  }

  updateDownload(id: string, state: "completed" | "failed"): void {
    const entry = this.downloads.find((d) => d.id === id);
    if (!entry || entry.state !== "started") return;
    entry.state = state;
    entry.atMs = Date.now();
  }

  recordRequest(requestId: string, method: string, url: string, type?: string): void {
    const entry: ObservedRequest = { seq: ++this.seq, method, url: redactUrl(url), type, atMs: Date.now() };
    this.requestsById.set(requestId, entry);
    push(this.requests, entry, this.limit * REQUEST_LIMIT_FACTOR);
    if (this.requestsById.size > this.limit * REQUEST_LIMIT_FACTOR) {
      const oldest = this.requestsById.keys().next().value;
      if (oldest !== undefined) this.requestsById.delete(oldest);
    }
  }

  recordResponse(requestId: string, status: number): void {
    const entry = this.requestsById.get(requestId);
    if (entry) entry.status = status;
  }

  recordRequestFailed(requestId: string, errorText: string): void {
    const entry = this.requestsById.get(requestId);
    if (entry) entry.failed = errorText;
  }

  /** Console entries and requests recorded after `afterSeq`, plus the cursor to pass next time. */
  sinceCursor(afterSeq: number): { console: ObservedConsole[]; requests: ObservedRequest[]; cursor: number } {
    return {
      console: this.console.filter((e) => e.seq > afterSeq),
      requests: this.requests.filter((e) => e.seq > afterSeq),
      cursor: this.seq,
    };
  }

  recordDialog(type: string, message: string, handledWith: DialogPolicy): void {
    push(this.dialogs, { type, message: message.slice(0, 500), handledWith, atMs: Date.now() }, this.limit);
  }

  recordNewTab(url: string): void {
    push(this.newTabUrls, url, this.limit);
  }

  since(afterMs = 0): ObservationSnapshot {
    return {
      console: this.console.filter((e) => e.atMs > afterMs),
      failedRequests: this.failedRequests.filter((e) => e.atMs > afterMs),
      downloads: this.downloads.filter((e) => e.atMs > afterMs),
      dialogs: this.dialogs.filter((e) => e.atMs > afterMs),
      newTabUrls: [...this.newTabUrls],
    };
  }

  clear(): void {
    this.console.length = 0;
    this.failedRequests.length = 0;
    this.downloads.length = 0;
    this.dialogs.length = 0;
    this.newTabUrls.length = 0;
    this.requests.length = 0;
    this.requestsById.clear();
  }
}

/** Turns on the CDP domains the observation buffers need.
 *
 *  `Log.enable` alone gives browser-level entries (network failures, security,
 *  deprecations) but NOT the page's own `console.*` calls; those require
 *  `Runtime.enable`, whose presence is a documented automation signal to bot
 *  detectors (rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-
 *  puppeteer-playwright-and-other-automation-libraries). Callers opt in per
 *  session with `pageConsole`. */
export async function enableObservation(
  send: CdpSend,
  sessionId: string,
  opts: { pageConsole?: boolean; downloadPath?: string } = {},
): Promise<void> {
  await send("Log.enable", {}, sessionId).catch(() => undefined);
  if (opts.pageConsole) await send("Runtime.enable", {}, sessionId).catch(() => undefined);
  await send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, sessionId).catch(() => undefined);
  const downloads = opts.downloadPath ? { behavior: "allow", downloadPath: opts.downloadPath } : { behavior: "deny" };
  await send("Page.setDownloadBehavior", downloads, sessionId).catch(() => undefined);
}

function push<T>(list: T[], item: T, limit: number): void {
  list.push(item);
  if (list.length > limit) list.shift();
}
