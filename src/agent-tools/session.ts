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
import { performAction, type ActionStep } from "./actions.js";
import { captureScreenshot, extractContent, type ExtractOptions, type ExtractResult, type ScreenshotOptions, type ScreenshotResult } from "./read.js";
import { enableObservation, Observations, type DialogPolicy, type ObservationSnapshot } from "./observe.js";
import { waitForCondition, type WaitCondition, type WaitResult } from "./wait.js";
import { SessionPolicy, type SessionPolicyOptions, type SessionState } from "./policy.js";

export interface TabHandle {
  tabId: string;
  targetId: string;
  cdpSessionId: string;
  url: string;
  refs: RefTable;
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

    const attached = (await this.send(
      "Target.attachToTarget",
      { targetId: created.targetId, flatten: true },
      undefined,
    )) as { sessionId?: string };
    if (!attached.sessionId) throw new Error("Target.attachToTarget returned no sessionId");

    this.attachObservers();
    await this.send("Page.enable", {}, attached.sessionId);
    await this.send("DOM.enable", {}, attached.sessionId);
    await this.send("Accessibility.enable", {}, attached.sessionId);
    await enableObservation(this.sender(), attached.sessionId, { pageConsole: this.opts.pageConsole === true });

    const tab: TabHandle = {
      tabId: `t${this.nextTabNumber++}`,
      targetId: created.targetId,
      cdpSessionId: attached.sessionId,
      url: "about:blank",
      refs: new RefTable(),
    };
    this.tabs.set(tab.tabId, tab);
    this.activeTabId = tab.tabId;
    if (url !== "about:blank") await this.navigate(url, tab.tabId);
    return tab;
  }

  async navigate(url: string, tabId?: string): Promise<NavigateResult> {
    const tab = await this.requireTab(tabId);
    this.policy.touch();
    tab.refs.clear();
    tab.lastSnapshot = undefined;

    const loaded = this.waitForLoad(tab.cdpSessionId);
    await this.send("Page.navigate", { url }, tab.cdpSessionId);
    await loaded;

    tab.url = await this.currentUrl(tab);
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
    tab.url = await this.currentUrl(tab);
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

  async snapshot(opts: SnapshotOptions = {}, tabId?: string): Promise<SnapshotResult> {
    const tab = await this.requireTab(tabId);
    this.policy.touch();
    const result = await buildSnapshot(this.sender(), tab.cdpSessionId, tab.refs, opts, tab.lastSnapshot);
    if (!result.unchanged) tab.lastSnapshot = result.text;
    return result;
  }

  /** Page content as text, markdown or a link list. */
  async extract(opts: ExtractOptions = {}, tabId?: string): Promise<ExtractResult> {
    const tab = await this.requireTab(tabId);
    this.policy.touch();
    return extractContent(this.sender(), tab.cdpSessionId, opts);
  }

  /** JPEG screenshot. With `skipIfUnchanged` an identical image is reported, not resent. */
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
    return waitForCondition(this.sender(), tab.cdpSessionId, condition);
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
        await this.send("Target.closeTarget", { targetId: tab.targetId }, undefined);
      } catch {
        /* target already gone */
      }
    }
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
    });
    this.cdp.on("Page.downloadWillBegin", (params) => {
      this.observations.recordDownload(String(params.url ?? ""), String(params.suggestedFilename ?? ""));
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
      const info = params.targetInfo as { type?: string; url?: string; openerId?: string } | undefined;
      if (info?.type === "page" && info.openerId) this.observations.recordNewTab(info.url ?? "");
    });
  }

  private sender(): CdpSend {
    return (method, params, sessionId) => this.send(method, params, sessionId);
  }

  private async settle(tab: TabHandle, settleMs: number): Promise<void> {
    if (settleMs <= 0) return;
    let navigated = false;
    const handler = (params: Record<string, unknown>): void => {
      if (params.__sessionId === tab.cdpSessionId) navigated = true;
    };
    this.cdp.on("Page.loadEventFired", handler);
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    this.cdp.off("Page.loadEventFired", handler);
    if (navigated) {
      tab.refs.clear();
      tab.lastSnapshot = undefined;
    }
  }

  private async send(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): Promise<unknown> {
    const timeoutMs = this.opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
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
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`navigation did not finish within ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.cdp.off("Page.loadEventFired", handler);
      };
      this.cdp.on("Page.loadEventFired", handler);
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
