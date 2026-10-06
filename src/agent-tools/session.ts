import type { CdpProtocolClient } from "../core/cdp/protocol.js";
import { RefTable } from "./refs.js";
import {
  buildSnapshot,
  diffSnapshots,
  type CdpSend,
  type SnapshotDiff,
  type SnapshotOptions,
  type SnapshotResult,
} from "./snapshot.js";
import { performAction, StaleRefError, type ActionStep } from "./actions.js";
import {
  captureScreenshot,
  extractContent,
  readViewportMetrics,
  type ExtractOptions,
  type ExtractResult,
  type ScreenshotOptions,
  type ScreenshotResult,
  type ViewportMetrics,
} from "./read.js";
import {
  enableObservation,
  Observations,
  type DialogPolicy,
  type ObservationSnapshot,
  type ObservedConsole,
  type ObservedRequest,
} from "./observe.js";
import { READ_TREE_FN, type PageTreeReply, type PageTreeRequest } from "./page-script.js";
import { findElements, type FindMatch } from "./find.js";
import { clampWaitTimeout, waitForCondition, waitForQuiet, type WaitCondition, type WaitResult } from "./wait.js";
import { SessionPolicy, type SessionPolicyOptions, type SessionState } from "./policy.js";
import {
  clickAt,
  drag,
  InputState,
  keyDown,
  keyUp,
  mouseDown,
  mouseMove,
  mouseUp,
  pressChord,
  pressSequence,
  releaseAll,
  wheelAt,
  type ClickOptions,
  type MouseButton,
} from "./input.js";
import type { Point } from "./types.js";

export interface TabHandle {
  tabId: string;
  targetId: string;
  cdpSessionId: string;
  url: string;
  refs: RefTable;
  input: InputState;
  lastSnapshot?: string;
  lastScreenshotHash?: string;
}

export interface AgentSessionOptions {
  /** Isolate each tab in its own browser context. Default true. */
  isolateTabs?: boolean;
  navigationTimeoutMs?: number;
  /** Per-CDP-command ceiling. A stalled upstream must never wedge a session. */
  commandTimeoutMs?: number;
  /** How javascript dialogs are answered so a prompt can never freeze the page. */
  dialogPolicy?: DialogPolicy;
  observationLimit?: number;
  /** Capture the page's own console.* calls. Off by default: it needs
   *  `Runtime.enable`, which bot detectors look for. */
  pageConsole?: boolean;
  policy?: SessionPolicyOptions;
  /** Track tabs a page opens (links with target=_blank, window.open) as session tabs. */
  adoptPopups?: boolean;
  /** Refuse to close the session's last tab. */
  keepLastTab?: boolean;
  /** Let downloads proceed, saved to this folder on the browser's machine. Denied by default. */
  downloadPath?: string;
}

export interface ReadPageOptions {
  /** visible (default): what is on screen, including text; interactive: only
   *  controls; all: the whole page. */
  filter?: "visible" | "interactive" | "all";
  depth?: number;
  /** Read only the part of the page inside this element. */
  ref?: string;
  maxChars?: number;
}

export interface ReadPageResult {
  text: string;
  truncated: boolean;
}

export interface TabInfo {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
}

export interface ActOptions {
  tabId?: string;
  stopOnError?: boolean;
  settleMs?: number;
  actionabilityTimeoutMs?: number;
  snapshot?: SnapshotOptions;
}

export interface ActResult {
  ok: boolean;
  stepsRun: number;
  failedStep?: { index: number; step: ActionStep; error: string };
  changed: SnapshotDiff;
  url: string;
  session: SessionState;
  warning?: string;
}

export interface NavigateResult {
  tabId: string;
  url: string;
  title: string;
  snapshot: SnapshotResult;
  session: SessionState;
  warning?: string;
}

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_MS = 500;
const MAX_SETTLE_MS = 10_000;
const LOAD_AFTER_ACTION_MS = 5_000;
const WAIT_REPLY_GRACE_MS = 5_000;
const READ_PAGE_DEFAULT_DEPTH = 15;
const READ_PAGE_MAX_CHARS = 50_000;
const FIND_LIMIT = 20;

/** One agent session bound to a browser-level CDP connection. Owns its tabs and
 *  their element reference tables; nothing is shared between sessions. */
export class AgentSession {
  private readonly tabs = new Map<string, TabHandle>();
  private activeTabId: string | null = null;
  private nextTabNumber = 1;
  private closed = false;
  private readonly observations: Observations;
  private readonly policy: SessionPolicy;
  private expiredReason: "idle" | "hard-cap" | null = null;
  private listenersAttached = false;
  private discovery?: Promise<unknown>;
  private viewportSize?: { width: number; height: number; deviceScaleFactor: number };
  private readonly adoptions = new Set<Promise<void>>();
  private readonly popupsAwaitingUrl = new Set<string>();

  constructor(
    private readonly cdp: CdpProtocolClient,
    private readonly opts: AgentSessionOptions = {},
  ) {
    this.observations = new Observations(opts.observationLimit, opts.dialogPolicy ?? "dismiss");
    this.policy = new SessionPolicy({
      ...opts.policy,
      onKeepalive: () => this.sendKeepalive(),
      onExpire: (reason) => this.expire(reason),
    });
    this.policy.start();
  }

  get state(): SessionState {
    return this.policy.state();
  }

  get expired(): "idle" | "hard-cap" | null {
    return this.expiredReason;
  }

  get tabIds(): string[] {
    return [...this.tabs.keys()];
  }

  /** A tab by id, or the active tab when no id is given. */
  tab(tabId?: string): TabHandle | null {
    return tabId ? (this.tabs.get(tabId) ?? null) : this.activeTab;
  }

  get activeTab(): TabHandle | null {
    return this.activeTabId ? (this.tabs.get(this.activeTabId) ?? null) : null;
  }

  async openTab(url = "about:blank"): Promise<TabHandle> {
    this.assertOpen();
    this.policy.touch();
    const params: Record<string, unknown> = { url: "about:blank" };
    if (this.opts.isolateTabs !== false) {
      const ctx = (await this.send("Target.createBrowserContext", { disposeOnDetach: true }, undefined)) as {
        browserContextId?: string;
      };
      if (ctx.browserContextId) params.browserContextId = ctx.browserContextId;
    }
    const created = (await this.send("Target.createTarget", params, undefined)) as { targetId?: string };
    if (!created.targetId) throw new Error("Target.createTarget returned no targetId");

    const tab = await this.registerTarget(created.targetId);
    this.activeTabId = tab.tabId;
    if (url !== "about:blank") await this.navigate(url, tab.tabId);
    return tab;
  }

  private async registerTarget(targetId: string): Promise<TabHandle> {
    const attached = (await this.send("Target.attachToTarget", { targetId, flatten: true }, undefined)) as {
      sessionId?: string;
    };
    if (!attached.sessionId) throw new Error("Target.attachToTarget returned no sessionId");
    const sessionId = attached.sessionId;

    this.attachObservers();
    const [macEditing] = await Promise.all([
      this.isMacBrowser(),
      this.send("Page.enable", {}, sessionId),
      this.ensureDiscovery(),
    ]);
    await enableObservation(this.sender(), sessionId, {
      pageConsole: this.opts.pageConsole === true,
      downloadPath: this.opts.downloadPath,
    });
    if (this.viewportSize) {
      await this.send("Emulation.setDeviceMetricsOverride", { ...this.viewportSize, mobile: false }, sessionId);
    }

    const tab: TabHandle = {
      tabId: `t${this.nextTabNumber++}`,
      targetId,
      cdpSessionId: sessionId,
      url: "about:blank",
      refs: new RefTable(),
      input: new InputState(),
    };
    tab.input.macEditing = macEditing;
    this.tabs.set(tab.tabId, tab);
    return tab;
  }

  private ensureDiscovery(): Promise<unknown> {
    this.discovery ??= this.send("Target.setDiscoverTargets", { discover: true }, undefined).catch(() => undefined);
    return this.discovery;
  }

  private adoptPopup(targetId: string, url: string): void {
    const job = (async () => {
      const tab = await this.registerTarget(targetId);
      tab.url = url;
      await tab.refs.world.warm(this.sender(), tab.cdpSessionId).catch(() => undefined);
    })()
      .catch(() => undefined)
      .finally(() => this.adoptions.delete(job));
    this.adoptions.add(job);
  }

  /** Waits until tabs the page just opened are attached and listed. */
  async settleTabs(): Promise<void> {
    while (this.adoptions.size > 0) await Promise.all([...this.adoptions]);
  }

  /** Every tab in the session with its current title and address. */
  async tabInventory(): Promise<TabInfo[]> {
    this.assertOpen();
    await this.settleTabs();
    const res = (await this.send("Target.getTargets", {}, undefined)) as {
      targetInfos?: Array<{ targetId: string; url?: string; title?: string }>;
    };
    const byId = new Map((res.targetInfos ?? []).map((t) => [t.targetId, t]));
    return [...this.tabs.values()].map((tab) => {
      const info = byId.get(tab.targetId);
      return {
        tabId: tab.tabId,
        url: info?.url ?? tab.url,
        title: info?.title ?? "",
        active: tab.tabId === this.activeTabId,
      };
    });
  }

  /** Makes a tab the active one and brings it to the front so it renders. */
  async activateTab(tabId: string): Promise<TabHandle> {
    const tab = this.selectTab(tabId);
    this.policy.touch();
    await this.send("Target.activateTarget", { targetId: tab.targetId }, undefined);
    return tab;
  }

  async navigate(url: string, tabId?: string): Promise<NavigateResult> {
    const tab = await this.requireTab(tabId);
    this.policy.touch();
    tab.refs.clear();
    tab.lastSnapshot = undefined;

    await this.loadingVia(tab, () => this.send("Page.navigate", { url }, tab.cdpSessionId));
    const title = await this.currentTitle(tab);
    const snapshot = await this.snapshot({}, tab.tabId);
    this.policy.touch();
    return { tabId: tab.tabId, url: tab.url, title, snapshot, session: this.policy.state(), warning: this.policy.warning() };
  }

  /** Runs steps in order against one tab, waits for the page to settle, and
   *  returns only what changed. Stops at the first failing step by default. */
  async act(steps: ActionStep[], opts: ActOptions = {}): Promise<ActResult> {
    const tab = await this.requireTab(opts.tabId);
    this.policy.touch();
    const before = tab.lastSnapshot;
    const send = this.sender();
    let stepsRun = 0;
    let failedStep: ActResult["failedStep"];

    for (const [index, step] of steps.entries()) {
      try {
        await performAction(send, tab.cdpSessionId, tab.refs, step, {
          actionabilityTimeoutMs: opts.actionabilityTimeoutMs,
          input: tab.input,
        });
        stepsRun++;
        this.policy.recordSuccess();
      } catch (err) {
        failedStep = { index, step, error: err instanceof Error ? err.message : String(err) };
        this.policy.recordFailure(step, failedStep.error);
        if (opts.stopOnError !== false) break;
      }
    }

    await this.settle(tab, opts.settleMs ?? DEFAULT_SETTLE_MS);
    const snapshot = await this.snapshot(opts.snapshot ?? {}, tab.tabId);
    tab.url = tab.refs.lastUrl ?? (await this.currentUrl(tab));
    this.policy.touch();
    return {
      ok: failedStep === undefined,
      stepsRun,
      failedStep,
      changed: diffSnapshots(before, snapshot.text),
      url: tab.url,
      session: this.policy.state(),
      warning: this.policy.warning(),
    };
  }

  /** Goes back or forward in the tab's history, or reloads it. */
  async history(direction: "back" | "forward" | "reload", tabId?: string): Promise<{ url: string; title: string }> {
    const tab = await this.requireTab(tabId);
    this.policy.touch();
    if (direction === "reload") {
      await this.loadingVia(tab, () => this.send("Page.reload", {}, tab.cdpSessionId));
    } else {
      const nav = (await this.send("Page.getNavigationHistory", {}, tab.cdpSessionId)) as {
        currentIndex: number;
        entries: Array<{ id: number }>;
      };
      const entry = nav.entries[nav.currentIndex + (direction === "back" ? -1 : 1)];
      if (!entry) throw new Error(direction === "back" ? "there is no earlier page in this tab" : "there is no later page in this tab");
      await this.loadingVia(tab, () => this.send("Page.navigateToHistoryEntry", { entryId: entry.id }, tab.cdpSessionId));
    }
    tab.refs.clear();
    tab.lastSnapshot = undefined;
    this.policy.touch();
    return { url: tab.url, title: await this.currentTitle(tab) };
  }

  async clickAt(point: Point, opts: ClickOptions = {}, tabId?: string): Promise<void> {
    await this.withInput(tabId, (send, sid, input) => clickAt(send, sid, input, point, opts));
  }

  async mouseMove(point: Point, tabId?: string): Promise<void> {
    await this.withInput(tabId, (send, sid, input) => mouseMove(send, sid, input, point));
  }

  /** Presses a mouse button and keeps it held until {@link mouseUp}. */
  async mouseDown(point?: Point, button: MouseButton = "left", tabId?: string): Promise<void> {
    await this.withInput(tabId, (send, sid, input) => mouseDown(send, sid, input, point, button));
  }

  async mouseUp(point?: Point, button: MouseButton = "left", tabId?: string): Promise<void> {
    await this.withInput(tabId, (send, sid, input) => mouseUp(send, sid, input, point, button));
  }

  async drag(from: Point, to: Point, tabId?: string): Promise<void> {
    await this.withInput(tabId, (send, sid, input) => drag(send, sid, input, from, to));
  }

  /** Scrolls by pixel deltas at a point, so the element under it scrolls. */
  async wheel(point: Point, deltaX: number, deltaY: number, tabId?: string): Promise<void> {
    await this.withInput(tabId, (send, sid, input) => wheelAt(send, sid, input, point, deltaX, deltaY));
  }

  /** Presses one chord given as parts (["Control", "c"]) or a space-separated
   *  sequence of chords ("ctrl+a Delete"). */
  async pressKeys(keys: string | string[], repeat = 1, tabId?: string): Promise<void> {
    await this.withInput(tabId, (send, sid, input) =>
      Array.isArray(keys) ? pressChord(send, sid, input, keys, repeat) : pressSequence(send, sid, input, keys, repeat),
    );
  }

  /** Types text at whatever has focus, as if pasted. */
  async typeText(text: string, tabId?: string): Promise<void> {
    await this.withInput(tabId, (send, sid) => send("Input.insertText", { text }, sid));
  }

  /** Holds a key down until {@link keyUp}; later input sees it as a held modifier. */
  async keyDown(name: string, tabId?: string): Promise<void> {
    await this.withInput(tabId, (send, sid, input) => keyDown(send, sid, input, name));
  }

  async keyUp(name: string, tabId?: string): Promise<void> {
    await this.withInput(tabId, (send, sid, input) => keyUp(send, sid, input, name));
  }

  /** Releases every held button and key in a tab. */
  async releaseInput(tabId?: string): Promise<void> {
    await this.withInput(tabId, (send, sid, input) => releaseAll(send, sid, input));
  }

  /** Waits until the page stops changing (at most `ms`), resetting refs if it navigated. */
  async waitForSettle(ms = DEFAULT_SETTLE_MS, tabId?: string): Promise<void> {
    const tab = await this.requireTab(tabId);
    await this.settle(tab, ms);
    tab.url = tab.refs.lastUrl ?? (await this.currentUrl(tab));
  }

  async snapshot(opts: SnapshotOptions = {}, tabId?: string): Promise<SnapshotResult> {
    const tab = await this.requireTab(tabId);
    this.policy.touch();
    const result = await buildSnapshot(this.sender(), tab.cdpSessionId, tab.refs, opts, tab.lastSnapshot);
    if (!result.unchanged) tab.lastSnapshot = result.text;
    return result;
  }

  /** The page as an indented outline of controls, headings and text, with refs
   *  that every action accepts. Refs already handed out keep their ids. */
  async readPage(opts: ReadPageOptions = {}, tabId?: string): Promise<ReadPageResult> {
    const tab = await this.requireTab(tabId);
    this.policy.touch();
    const maxChars = Math.min(opts.maxChars ?? READ_PAGE_MAX_CHARS, READ_PAGE_MAX_CHARS);
    const request: PageTreeRequest = {
      filter: opts.filter ?? "visible",
      depth: opts.depth ?? READ_PAGE_DEFAULT_DEPTH,
      ref: opts.ref,
      maxChars,
    };
    const reply = await tab.refs.world.call<PageTreeReply>(this.sender(), tab.cdpSessionId, READ_TREE_FN, request);
    if (reply?.missingRef) throw new StaleRefError(opts.ref ?? "", "Read the page again and use the new refs.");
    for (const [ref, role, name] of reply?.refs ?? []) tab.refs.set(ref, { role, name });
    const lines = reply?.lines ?? [];
    if (reply?.truncated) {
      lines.push(`... cut at ${maxChars} characters. Read part of the page with a ref, or use filter "interactive".`);
    }
    return { text: lines.length ? lines.join("\n") : "(nothing to show)", truncated: reply?.truncated === true };
  }

  /** Elements matching a plain-language description, best first, by shared words. */
  async find(query: string, tabId?: string): Promise<FindMatch[]> {
    const tab = await this.requireTab(tabId);
    await this.readPage({ filter: "all", maxChars: READ_PAGE_MAX_CHARS }, tab.tabId);
    return findElements(query, tab.refs.entriesList(), FIND_LIMIT);
  }

  /** Console output and network requests recorded after `cursor`, with the cursor to pass next time. */
  readLogs(cursor = 0): { console: ObservedConsole[]; requests: ObservedRequest[]; cursor: number } {
    return this.observations.sinceCursor(cursor);
  }

  /** Page content as text, markdown or a link list. */
  async extract(opts: ExtractOptions = {}, tabId?: string): Promise<ExtractResult> {
    const tab = await this.requireTab(tabId);
    this.policy.touch();
    return extractContent(this.sender(), tab.cdpSessionId, opts);
  }

  /** Fixes the page size the tab renders at, in CSS pixels. `deviceScaleFactor`
   *  defaults to 1 so screenshot pixels and input coordinates are the same unit. */
  async setViewport(size: { width: number; height: number; deviceScaleFactor?: number }, tabId?: string): Promise<void> {
    const tab = await this.requireTab(tabId);
    this.policy.touch();
    this.viewportSize = { width: size.width, height: size.height, deviceScaleFactor: size.deviceScaleFactor ?? 1 };
    await this.send("Emulation.setDeviceMetricsOverride", { ...this.viewportSize, mobile: false }, tab.cdpSessionId);
  }

  /** The visible area as the page reports it now, which may differ from what was asked for. */
  async viewport(tabId?: string): Promise<ViewportMetrics> {
    const tab = await this.requireTab(tabId);
    this.policy.touch();
    return readViewportMetrics(this.sender(), tab.cdpSessionId);
  }

  /** Screenshot, JPEG unless asked otherwise. With `skipIfUnchanged` an identical image is reported, not resent. */
  async screenshot(opts: ScreenshotOptions = {}, tabId?: string): Promise<ScreenshotResult> {
    const tab = await this.requireTab(tabId);
    this.policy.touch();
    const { result, hash } = await captureScreenshot(
      this.sender(),
      tab.cdpSessionId,
      tab.refs,
      opts,
      tab.lastScreenshotHash,
    );
    tab.lastScreenshotHash = hash;
    return result;
  }

  async waitFor(condition: WaitCondition, tabId?: string): Promise<WaitResult> {
    const tab = await this.requireTab(tabId);
    this.policy.touch();
    const window = clampWaitTimeout(condition.timeoutMs);
    return waitForCondition(this.sender(window + WAIT_REPLY_GRACE_MS), tab.cdpSessionId, tab.refs, condition);
  }

  /** Runs an expression in the page and returns its value. */
  async evaluate<T = unknown>(expression: string, tabId?: string): Promise<T | undefined> {
    const tab = await this.requireTab(tabId);
    this.policy.touch();
    const res = (await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      tab.cdpSessionId,
    )) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "evaluate failed");
    }
    return res.result?.value as T | undefined;
  }

  /** Console output, failed requests, downloads, dialogs and popup tabs seen so far. */
  observed(afterMs = 0): ObservationSnapshot {
    return this.observations.since(afterMs);
  }

  setDialogPolicy(policy: DialogPolicy): void {
    this.observations.dialogPolicy = policy;
  }

  async closeTab(tabId: string): Promise<void> {
    this.policy.touch();
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`unknown tab ${tabId}`);
    if (this.opts.keepLastTab && this.tabs.size === 1) {
      throw new Error("this is the only tab. Open another tab before closing it.");
    }
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) this.activeTabId = this.tabs.keys().next().value ?? null;
    await this.send("Target.closeTarget", { targetId: tab.targetId }, undefined);
  }

  selectTab(tabId: string): TabHandle {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`unknown tab ${tabId}`);
    this.activeTabId = tabId;
    return tab;
  }

  /** Closes this session's tabs. Never closes the upstream browser: it may be
   *  shared with other sessions and other clients. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.policy.stop();
    const tabs = [...this.tabs.values()];
    this.tabs.clear();
    this.activeTabId = null;
    for (const tab of tabs) {
      try {
        await releaseAll(this.sender(), tab.cdpSessionId, tab.input);
      } catch {
        /* page already gone */
      }
      try {
        await this.send("Target.closeTarget", { targetId: tab.targetId }, undefined);
      } catch {
        /* target already gone */
      }
    }
  }

  private async withInput(
    tabId: string | undefined,
    run: (send: CdpSend, sessionId: string, input: InputState) => Promise<unknown>,
  ): Promise<void> {
    const tab = await this.requireTab(tabId);
    this.policy.touch();
    await run(this.sender(), tab.cdpSessionId, tab.input);
    this.policy.touch();
  }

  /** Runs a command that starts a page load and waits for the load to finish,
   *  including pages restored from the back-forward cache. */
  private async loadingVia(tab: TabHandle, start: () => Promise<unknown>): Promise<void> {
    const loaded = this.waitForLoad(tab.cdpSessionId);
    // Claim the rejection now: if the command below throws, nothing awaits this
    // promise and its later timeout would end the process.
    loaded.catch(() => undefined);
    await start();
    await loaded;
    await tab.refs.world.warm(this.sender(), tab.cdpSessionId);
    tab.url = await this.currentUrl(tab);
  }

  private async requireTab(tabId?: string): Promise<TabHandle> {
    this.assertOpen();
    if (tabId) {
      const tab = this.tabs.get(tabId);
      if (!tab) throw new Error(`unknown tab ${tabId}`);
      return tab;
    }
    const active = this.activeTab;
    return active ?? (await this.openTab());
  }

  private macBrowser?: Promise<boolean>;

  private isMacBrowser(): Promise<boolean> {
    this.macBrowser ??= this.send("Browser.getVersion", {}, undefined)
      .then((v) => /Macintosh|Mac OS X/.test(String((v as { userAgent?: string }).userAgent ?? "")))
      .catch(() => false);
    return this.macBrowser;
  }

  private async sendKeepalive(): Promise<void> {
    if (this.closed) return;
    await this.send("Browser.getVersion", {}, undefined).catch(() => undefined);
  }

  private async expire(reason: "idle" | "hard-cap"): Promise<void> {
    this.expiredReason = reason;
    await this.close();
  }

  private attachObservers(): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    this.cdp.on("Log.entryAdded", (params) => {
      const entry = params.entry as { level?: string; text?: string } | undefined;
      if (entry?.text) this.observations.recordConsole(entry.level ?? "info", entry.text);
    });
    this.cdp.on("Runtime.consoleAPICalled", (params) => {
      const args = (params.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
      const text = args.map((a) => String(a.value ?? a.description ?? "")).join(" ");
      if (text) this.observations.recordConsole(String(params.type ?? "log"), text);
    });
    this.cdp.on("Network.loadingFailed", (params) => {
      const url = String(params.documentURL ?? "");
      this.observations.recordFailedRequest(url, String(params.errorText ?? "failed"));
      if (typeof params.requestId === "string") {
        this.observations.recordRequestFailed(params.requestId, String(params.errorText ?? "failed"));
      }
    });
    this.cdp.on("Network.requestWillBeSent", (params) => {
      const request = params.request as { method?: string; url?: string } | undefined;
      if (typeof params.requestId !== "string" || !request?.url) return;
      this.observations.recordRequest(
        params.requestId,
        request.method ?? "GET",
        request.url,
        typeof params.type === "string" ? params.type : undefined,
      );
    });
    this.cdp.on("Network.responseReceived", (params) => {
      const response = params.response as { status?: number } | undefined;
      if (typeof params.requestId === "string" && typeof response?.status === "number") {
        this.observations.recordResponse(params.requestId, response.status);
      }
    });
    this.cdp.on("Page.downloadWillBegin", (params) => {
      this.observations.recordDownload(
        String(params.url ?? ""),
        String(params.suggestedFilename ?? ""),
        typeof params.guid === "string" ? params.guid : undefined,
      );
    });
    this.cdp.on("Page.downloadProgress", (params) => {
      if (typeof params.guid !== "string") return;
      if (params.state === "completed") this.observations.updateDownload(params.guid, "completed");
      if (params.state === "canceled") this.observations.updateDownload(params.guid, "failed");
    });
    this.cdp.on("Page.javascriptDialogOpening", (params) => {
      const policy = this.observations.dialogPolicy;
      this.observations.recordDialog(String(params.type ?? "dialog"), String(params.message ?? ""), policy);
      const sessionId = typeof params.__sessionId === "string" ? params.__sessionId : undefined;
      void this.send("Page.handleJavaScriptDialog", { accept: policy === "accept" }, sessionId).catch(
        () => undefined,
      );
    });
    this.cdp.on("Target.targetCreated", (params) => {
      const info = params.targetInfo as { type?: string; url?: string; openerId?: string; targetId?: string } | undefined;
      if (info?.type !== "page" || !info.openerId || !info.targetId || !this.ownsTarget(info.openerId)) return;
      if (info.url) this.observations.recordNewTab(info.url);
      else this.popupsAwaitingUrl.add(info.targetId);
      if (this.opts.adoptPopups && !this.closed) this.adoptPopup(info.targetId, info.url ?? "");
    });
    this.cdp.on("Target.targetInfoChanged", (params) => {
      const info = params.targetInfo as { url?: string; targetId?: string } | undefined;
      if (!info?.targetId || !info.url || !this.popupsAwaitingUrl.delete(info.targetId)) return;
      this.observations.recordNewTab(info.url);
    });
    this.cdp.on("Target.targetDestroyed", (params) => {
      const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
      for (const [tabId, tab] of this.tabs) {
        if (tab.targetId !== targetId) continue;
        this.tabs.delete(tabId);
        if (this.activeTabId === tabId) this.activeTabId = this.tabs.keys().next().value ?? null;
      }
    });
  }

  private ownsTarget(targetId: string): boolean {
    for (const tab of this.tabs.values()) if (tab.targetId === targetId) return true;
    return false;
  }

  private sender(minTimeoutMs?: number): CdpSend {
    return (method, params, sessionId) => this.send(method, params, sessionId, minTimeoutMs);
  }

  private async settle(tab: TabHandle, settleMs: number): Promise<void> {
    const wait = Math.min(settleMs, MAX_SETTLE_MS);
    if (!Number.isFinite(wait) || wait <= 0) return;
    let navigated = false;
    let loading = false;
    let loaded: () => void = () => undefined;
    const loadDone = new Promise<void>((resolve) => (loaded = resolve));
    const onLoad = (params: Record<string, unknown>): void => {
      if (params.__sessionId !== tab.cdpSessionId) return;
      navigated = true;
      loading = false;
      loaded();
    };
    const onStart = (params: Record<string, unknown>): void => {
      if (params.__sessionId !== tab.cdpSessionId) return;
      const main = tab.refs.world.mainFrameId;
      if (main === undefined || params.frameId === main) loading = true;
    };
    this.cdp.on("Page.loadEventFired", onLoad);
    this.cdp.on("Page.frameStartedLoading", onStart);
    await waitForQuiet(this.sender(), tab.cdpSessionId, tab.refs, wait).catch(() =>
      new Promise((resolve) => setTimeout(resolve, wait)),
    );
    // An action that started a page load finishes on the new page, not mid-load.
    if (loading) await Promise.race([loadDone, new Promise((resolve) => setTimeout(resolve, LOAD_AFTER_ACTION_MS))]);
    this.cdp.off("Page.loadEventFired", onLoad);
    this.cdp.off("Page.frameStartedLoading", onStart);
    if (navigated) {
      tab.refs.clear();
      tab.lastSnapshot = undefined;
      await tab.refs.world.warm(this.sender(), tab.cdpSessionId);
    }
  }

  private async send(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
    minTimeoutMs = 0,
  ): Promise<unknown> {
    const timeoutMs = Math.max(this.opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, minTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.cdp.sendOn(method, params, sessionId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private assertOpen(): void {
    if (this.expiredReason === "idle") {
      throw new Error(
        `this browser closed after ${Math.round(this.policy.idleMs / 60_000)} minutes without an action. Open a new session; page state was reset.`,
      );
    }
    if (this.expiredReason === "hard-cap") {
      throw new Error("this browser hit its maximum session length. Open a new session; page state was reset.");
    }
    if (this.closed) throw new Error("agent session is closed");
  }

  private waitForLoad(cdpSessionId: string): Promise<void> {
    const timeoutMs = this.opts.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const handler = (params: Record<string, unknown>): void => {
        if (params.__sessionId !== cdpSessionId) return;
        cleanup();
        resolve();
      };
      const restored = (params: Record<string, unknown>): void => {
        if (params.type === "BackForwardCacheRestore") handler(params);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`navigation did not finish within ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.cdp.off("Page.loadEventFired", handler);
        this.cdp.off("Page.frameNavigated", restored);
      };
      this.cdp.on("Page.loadEventFired", handler);
      this.cdp.on("Page.frameNavigated", restored);
    });
  }

  private async currentUrl(tab: TabHandle): Promise<string> {
    const res = (await this.send(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      tab.cdpSessionId,
    )) as { result?: { value?: unknown } };
    return typeof res.result?.value === "string" ? res.result.value : tab.url;
  }

  private async currentTitle(tab: TabHandle): Promise<string> {
    const res = (await this.send(
      "Runtime.evaluate",
      { expression: "document.title", returnByValue: true },
      tab.cdpSessionId,
    )) as { result?: { value?: unknown } };
    return typeof res.result?.value === "string" ? res.result.value : "";
  }
}
