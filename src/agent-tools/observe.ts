import type { CdpSend } from "./snapshot.js";

export type DialogPolicy = "accept" | "dismiss";

export interface ObservedDialog {
  type: string;
  message: string;
  handledWith: DialogPolicy;
  atMs: number;
}

export interface ObservedConsole {
  level: string;
  text: string;
  atMs: number;
}

export interface ObservedRequestFailure {
  url: string;
  errorText: string;
  atMs: number;
}

export interface ObservedDownload {
  url: string;
  fileName: string;
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

/** Per-session ring buffers for console output, failed requests, downloads,
 *  dialogs and popup tabs. Dialogs are answered automatically so an unanswered
 *  prompt can never freeze the page. */
export class Observations {
  readonly console: ObservedConsole[] = [];
  readonly failedRequests: ObservedRequestFailure[] = [];
  readonly downloads: ObservedDownload[] = [];
  readonly dialogs: ObservedDialog[] = [];
  readonly newTabUrls: string[] = [];

  constructor(
    private readonly limit = DEFAULT_LIMIT,
    public dialogPolicy: DialogPolicy = "dismiss",
  ) {}

  recordConsole(level: string, text: string): void {
    push(this.console, { level, text: text.slice(0, 500), atMs: Date.now() }, this.limit);
  }

  recordFailedRequest(url: string, errorText: string): void {
    push(this.failedRequests, { url, errorText, atMs: Date.now() }, this.limit);
  }

  recordDownload(url: string, fileName: string): void {
    push(this.downloads, { url, fileName, atMs: Date.now() }, this.limit);
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
  opts: { pageConsole?: boolean } = {},
): Promise<void> {
  await send("Log.enable", {}, sessionId).catch(() => undefined);
  if (opts.pageConsole) await send("Runtime.enable", {}, sessionId).catch(() => undefined);
  await send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, sessionId).catch(() => undefined);
  await send("Page.setDownloadBehavior", { behavior: "deny" }, sessionId).catch(() => undefined);
}

function push<T>(list: T[], item: T, limit: number): void {
  list.push(item);
  if (list.length > limit) list.shift();
}
