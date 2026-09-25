import { describe, expect, it } from "vitest";
import { CdpProtocolClient } from "../../src/core/cdp/protocol.js";
import type { CdpTransport } from "../../src/core/cdp/protocol.js";
import { AgentSession, NotActionableError, RefTable, StaleRefError, agentToolDefinitions, clampWaitTimeout, waitForCondition } from "../../src/agent-tools/index.js";
import { performAction } from "../../src/agent-tools/actions.js";

interface PageItem {
  ref?: string;
  role: string;
  name?: string;
  state?: string;
  context?: boolean;
  offscreen?: boolean;
}

/** Stands in for the isolated-world page script: the real walk runs against Chrome in
 *  the integration suite, so here only the scope filters it applies are modelled. */
class FakeBrowser implements CdpTransport {
  sent: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  items: PageItem[] = [];
  capped = false;
  staleRefs = new Set<string>();
  disabled = false;
  checked = false;
  selectWorks = true;
  screenshotData = "aaaabbbb";
  evaluateValue: unknown = "page text";
  evaluateThrows = false;
  waitMet = true;
  waitReplyDelayMs = 0;
  worldsCreated = 0;

  emitEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.onMsg?.(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  }
  private onMsg: ((data: string) => void) | null = null;
  private contexts = 0;
  private targets = 0;

  send(frame: string): void {
    const msg = JSON.parse(frame) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
    this.sent.push({ method: msg.method, params: msg.params, sessionId: msg.sessionId });
    const reply = (result: unknown): void => this.onMsg?.(JSON.stringify({ id: msg.id, result }));

    switch (msg.method) {
      case "Target.createBrowserContext":
        return reply({ browserContextId: `ctx${++this.contexts}` });
      case "Target.createTarget":
        return reply({ targetId: `target${++this.targets}` });
      case "Target.attachToTarget":
        return reply({ sessionId: `cdp-${String(msg.params.targetId)}` });
      case "Page.navigate":
        reply({ frameId: "f1" });
        this.onMsg?.(JSON.stringify({ method: "Page.loadEventFired", params: {}, sessionId: msg.sessionId }));
        return;
      case "Page.getFrameTree":
        return reply({ frameTree: { frame: { id: "frame-1" } } });
      case "Page.createIsolatedWorld":
        this.worldsCreated++;
        return reply({ executionContextId: 100 + this.worldsCreated });
      case "Page.captureScreenshot":
        return reply({ data: this.screenshotData });
      case "Runtime.evaluate": {
        const value = this.evaluated(msg.params);
        if (this.waitReplyDelayMs > 0 && String(msg.params.expression).includes('"kind"')) {
          setTimeout(() => reply(value), this.waitReplyDelayMs);
          return;
        }
        return reply(value);
      }
      default:
        return reply({});
    }
  }

  private evaluated(params: Record<string, unknown>): unknown {
    const expr = String(params.expression);
    if (params.contextId === undefined) {
      if (expr === "document.title") return { result: { value: "Test page" } };
      if (expr === "location.href") return { result: { value: "https://example.test/page" } };
      if (this.evaluateThrows) return { exceptionDetails: { text: "boom" } };
      return { result: { value: this.evaluateValue } };
    }
    const arg = JSON.parse(expr.slice(expr.lastIndexOf("(") + 1, expr.lastIndexOf(")"))) as Record<string, unknown>;
    if ("maxNodes" in arg) return { result: { value: this.snapshotReply(arg) } };
    if ("mode" in arg) return { result: { value: this.resolveReply(arg) } };
    if ("quietMs" in arg) return { result: { value: 0 } };
    return { result: { value: { met: this.waitMet, waitedMs: this.waitMet ? 120 : 0 } } };
  }

  private snapshotReply(arg: Record<string, unknown>): unknown {
    const lines: string[] = [];
    const refs: Array<[string, string, string]> = [];
    let outsideViewport = 0;
    for (const item of this.items) {
      const interactive = item.context !== true;
      if (arg.interactiveOnly === true && !interactive) continue;
      if (arg.viewportOnly === true && item.offscreen === true) {
        outsideViewport++;
        continue;
      }
      const name = item.name ? ` "${item.name}"` : "";
      if (interactive) {
        const ref = item.ref ?? `e${refs.length + 1}`;
        refs.push([ref, item.role, item.name ?? ""]);
        lines.push(`${ref} ${item.role}${name}${item.state ?? ""}`);
      } else {
        lines.push(`- ${item.role}${name}`);
      }
    }
    return { lines, refs, outsideViewport, capped: this.capped };
  }

  private resolveReply(arg: Record<string, unknown>): unknown {
    const ref = String(arg.ref);
    if (this.staleRefs.has(ref)) return { ok: false, stale: true };
    if (arg.mode === "select") {
      return this.selectWorks ? { ok: true, done: true } : { ok: false, reason: `no option matching "${String(arg.option)}"` };
    }
    if (arg.mode === "focus-select") return { ok: true, done: true };
    if (arg.mode === "rect") return { ok: true, x: 10, y: 100, width: 90, height: 20 };
    if (this.disabled) return { ok: false, reason: "is disabled" };
    return { ok: true, x: 55, y: 110, checked: this.checked };
  }

  reply(id: number, result: unknown): void {
    this.onMsg?.(JSON.stringify({ id, result }));
  }

  onMessage(cb: (data: string) => void): void {
    this.onMsg = cb;
  }
  onClose(): void {}
  async close(): Promise<void> {}

  methodsCalled(method: string): Array<Record<string, unknown>> {
    return this.sent.filter((s) => s.method === method).map((s) => s.params);
  }
}

function newSession(opts?: { isolateTabs?: boolean }): { fake: FakeBrowser; session: AgentSession } {
  const fake = new FakeBrowser();
  const session = new AgentSession(new CdpProtocolClient(fake), opts);
  return { fake, session };
}

const FORM_PAGE: PageItem[] = [
  { role: "heading", name: "Sign in", context: true },
  { ref: "e1", role: "textbox", name: "Email", state: ' value="a@b.c"' },
  { ref: "e2", role: "textbox", name: "Password", state: " required" },
  { ref: "e3", role: "checkbox", name: "Remember me", state: " checked=false" },
  { ref: "e4", role: "button", name: "Sign in" },
];

describe("AgentSession", () => {
  it("opens a tab in its own browser context and attaches flattened", async () => {
    const { fake, session } = newSession();
    await session.openTab();
    expect(fake.methodsCalled("Target.createBrowserContext")).toHaveLength(1);
    expect(fake.methodsCalled("Target.createTarget")[0]).toMatchObject({ browserContextId: "ctx1" });
    expect(fake.methodsCalled("Target.attachToTarget")[0]).toMatchObject({ flatten: true });
  });

  it("skips the browser context when isolation is off", async () => {
    const { fake, session } = newSession({ isolateTabs: false });
    await session.openTab();
    expect(fake.methodsCalled("Target.createBrowserContext")).toHaveLength(0);
  });

  it("navigates and returns url, title and a snapshot", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    const result = await session.navigate("https://example.test/page");
    expect(result.url).toBe("https://example.test/page");
    expect(result.title).toBe("Test page");
    expect(result.snapshot.text).toContain('e1 textbox "Email"');
    expect(result.snapshot.text).toContain('e4 button "Sign in"');
  });

  it("reads the page in a single evaluate, whatever its size", async () => {
    const { fake, session } = newSession();
    await session.navigate("https://example.test/page");
    for (const count of [5, 500]) {
      fake.items = Array.from({ length: count }, (_, i) => ({ ref: `e${i + 1}`, role: "button", name: `Item ${i}` }));
      fake.sent.length = 0;
      await session.snapshot({ maxLines: count });
      expect(fake.sent).toHaveLength(1);
      expect(fake.sent[0]?.method).toBe("Runtime.evaluate");
    }
  });

  it("asks the page only for interactive elements by default", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.openTab();
    const snap = await session.snapshot();
    expect(snap.text).not.toContain("heading");
    expect(snap.text.split("\n")).toHaveLength(4);
    expect(fake.methodsCalled("Runtime.evaluate").at(-1)?.expression).toContain('"interactiveOnly":true');
  });

  it("includes landmarks when interactiveOnly is off", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.openTab();
    const snap = await session.snapshot({ interactiveOnly: false });
    expect(snap.text).toContain('- heading "Sign in"');
  });

  it("reports element state the agent needs", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.openTab();
    const snap = await session.snapshot();
    expect(snap.text).toContain('value="a@b.c"');
    expect(snap.text).toContain("required");
    expect(snap.text).toContain("checked=false");
  });

  it("drops elements outside the viewport and says how to see them", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE.map((i) => (i.ref === "e4" ? { ...i, offscreen: true } : i));
    await session.openTab();
    const snap = await session.snapshot();
    expect(snap.text).not.toContain('button "Sign in"');
    expect(snap.text).toContain("1 elements outside the viewport");
    expect(snap.text).toContain('scope:"full"');
    const full = await session.snapshot({ scope: "full" });
    expect(full.text).toContain('button "Sign in"');
  });

  it("caps long pages and tells the agent how to narrow", async () => {
    const { fake, session } = newSession();
    fake.items = Array.from({ length: 50 }, (_, i) => ({ ref: `e${i + 1}`, role: "button", name: `Item ${i}` }));
    await session.openTab();
    const snap = await session.snapshot({ maxLines: 10 });
    expect(snap.truncated).toBe(true);
    expect(snap.text).toContain("40 more elements");
    expect(snap.text).toContain("maxLines");
  });

  it("says so when the page is too large for the walk to finish", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    fake.capped = true;
    await session.openTab();
    expect((await session.snapshot()).text).toContain("too large to read in full");
  });

  it("reports an unchanged page instead of resending it", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.openTab();
    await session.snapshot();
    const again = await session.snapshot({ sinceLast: true });
    expect(again.unchanged).toBe(true);
    expect(again.text).toBe("unchanged since last snapshot");
  });

  it("keeps refs per tab and clears them on navigation", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    const tabA = await session.openTab();
    await session.snapshot({}, tabA.tabId);
    const tabB = await session.openTab();
    await session.snapshot({}, tabB.tabId);
    expect(tabA.refs.get("e1")?.name).toBe("Email");
    expect(tabB.refs.get("e1")?.name).toBe("Email");
    expect(tabA.refs).not.toBe(tabB.refs);

    await session.navigate("https://example.test/other", tabA.tabId);
    expect(tabA.refs.size).toBe(4);
  });

  it("lets a wait run past the per-command timeout, up to its own window", async () => {
    const fake = new FakeBrowser();
    const session = new AgentSession(new CdpProtocolClient(fake), { commandTimeoutMs: 50 });
    const tab = await session.openTab();
    fake.waitReplyDelayMs = 150;
    await expect(session.waitFor({ text: "late", timeoutMs: 400 }, tab.tabId)).resolves.toMatchObject({ met: true });
  });

  it("caps the post-action settle wait so a caller cannot park the session", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    const started = Date.now();
    await session.act([{ type: "click", ref: "e4" }], { settleMs: 60 * 60 * 1000 });
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it("does not leave a dangling load rejection when the navigate command fails", async () => {
    const fake = new FakeBrowser();
    const session = new AgentSession(new CdpProtocolClient(fake), { commandTimeoutMs: 20, navigationTimeoutMs: 200 });
    const tab = await session.openTab();
    const original = fake.send.bind(fake);
    fake.send = (frame: string): void => {
      const msg = JSON.parse(frame) as { method: string };
      if (msg.method === "Page.navigate") return;
      original(frame);
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(session.navigate("https://slow.test", tab.tabId)).rejects.toThrow("timed out after 20ms");
      await new Promise((resolve) => setTimeout(resolve, 400));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("rebuilds the isolated world when a navigation tears it down", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    const tab = await session.openTab();
    await session.snapshot();
    const before = fake.worldsCreated;
    await session.navigate("https://example.test/other", tab.tabId);
    expect(fake.worldsCreated).toBeGreaterThan(before);
  });

  it("gives two sessions independent tabs and refs", async () => {
    const one = newSession();
    const two = newSession();
    one.fake.items = FORM_PAGE;
    two.fake.items = [{ ref: "e1", role: "link", name: "Only link" }];
    await one.session.openTab();
    await two.session.openTab();
    const snapOne = await one.session.snapshot();
    const snapTwo = await two.session.snapshot();
    expect(snapOne.text).toContain("Email");
    expect(snapTwo.text).toBe('e1 link "Only link"');
    expect(one.session.tabIds).toEqual(["t1"]);
    expect(two.session.tabIds).toEqual(["t1"]);
  });

  it("closes only its own targets, never the browser", async () => {
    const { fake, session } = newSession();
    await session.openTab();
    await session.openTab();
    await session.close();
    expect(fake.methodsCalled("Target.closeTarget")).toHaveLength(2);
    expect(fake.methodsCalled("Browser.close")).toHaveLength(0);
    await expect(session.openTab()).rejects.toThrow("closed");
  });

  it("closing one tab leaves the others usable", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    const a = await session.openTab();
    const b = await session.openTab();
    await session.closeTab(a.tabId);
    expect(session.tabIds).toEqual([b.tabId]);
    await expect(session.snapshot({}, a.tabId)).rejects.toThrow("unknown tab");
    await expect(session.snapshot({}, b.tabId)).resolves.toBeTruthy();
  });

  it("clicks with real mouse events at the point the page resolved", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    const result = await session.act([{ type: "click", ref: "e4" }], { settleMs: 0 });
    expect(result.ok).toBe(true);
    const mouse = fake.methodsCalled("Input.dispatchMouseEvent");
    expect(mouse.map((m) => m.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(mouse[1]).toMatchObject({ x: 55, y: 110, button: "left", clickCount: 1 });
  });

  it("resolves an action in one page call, then one burst of input", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    fake.sent.length = 0;
    await session.act([{ type: "click", ref: "e4" }], { settleMs: 0, snapshot: {} });
    const evaluates = fake.sent.filter((s) => s.method === "Runtime.evaluate" && s.params.contextId !== undefined);
    expect(evaluates).toHaveLength(2);
    expect(fake.methodsCalled("Input.dispatchMouseEvent")).toHaveLength(3);
  });

  it("fills a field by selecting existing text first, types without clearing", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    fake.sent.length = 0;
    await session.act([{ type: "fill", ref: "e1", text: "new@example.test" }], { settleMs: 0 });
    expect(
      fake.methodsCalled("Runtime.evaluate").filter((c) => String(c.expression).includes('"mode":"focus-select"')),
    ).toHaveLength(1);
    expect(fake.methodsCalled("Input.insertText")[0]).toMatchObject({ text: "new@example.test" });
    expect(
      fake.methodsCalled("Runtime.evaluate").filter((c) => String(c.expression).includes('"acceptFocused":true')),
    ).toHaveLength(1);

    fake.sent.length = 0;
    await session.act([{ type: "type", ref: "e1", text: "more" }], { settleMs: 0 });
    expect(
      fake.methodsCalled("Runtime.evaluate").filter((c) => String(c.expression).includes('"mode":"focus-select"')),
    ).toHaveLength(0);
  });

  it("presses named keys with the right key codes", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    await session.act([{ type: "press", key: "Enter" }], { settleMs: 0 });
    const keys = fake.methodsCalled("Input.dispatchKeyEvent");
    expect(keys[0]).toMatchObject({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    expect(keys.some((k) => k.type === "char" && k.text === "\r")).toBe(true);
    expect(keys.at(-1)).toMatchObject({ type: "keyUp" });
  });

  it("only clicks a checkbox when its state needs to change", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    fake.checked = false;
    await session.act([{ type: "check", ref: "e3" }], { settleMs: 0 });
    expect(fake.methodsCalled("Input.dispatchMouseEvent").some((m) => m.type === "mousePressed")).toBe(true);

    fake.sent.length = 0;
    fake.checked = true;
    await session.act([{ type: "check", ref: "e3" }], { settleMs: 0 });
    expect(fake.methodsCalled("Input.dispatchMouseEvent").some((m) => m.type === "mousePressed")).toBe(false);
  });

  it("runs several steps in one call and reports what changed", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    fake.items = [{ ref: "e1", role: "button", name: "Signed in" }];
    const result = await session.act(
      [
        { type: "fill", ref: "e1", text: "user@example.test" },
        { type: "fill", ref: "e2", text: "hunter2" },
        { type: "click", ref: "e4" },
      ],
      { settleMs: 0 },
    );
    expect(result.ok).toBe(true);
    expect(result.stepsRun).toBe(3);
    expect(result.changed.text).toContain('+ e1 button "Signed in"');
    expect(result.changed.text).toContain('- e1 textbox "Email"');
  });

  it("stops at the first failing step and names it", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    const result = await session.act(
      [{ type: "click", ref: "e1" }, { type: "click", ref: "e99" }, { type: "click", ref: "e4" }],
      { settleMs: 0 },
    );
    expect(result.ok).toBe(false);
    expect(result.stepsRun).toBe(1);
    expect(result.failedStep?.index).toBe(1);
    expect(result.failedStep?.error).toContain("no longer on the page");
  });

  it("keeps going after a failure when stopOnError is off", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    const result = await session.act(
      [{ type: "click", ref: "e99" }, { type: "click", ref: "e4" }],
      { settleMs: 0, stopOnError: false },
    );
    expect(result.stepsRun).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("reports no visible change when the page did not move", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    const result = await session.act([{ type: "hover", ref: "e4" }], { settleMs: 0 });
    expect(result.changed.text).toBe("no visible change");
  });

  it("tells the agent to re-snapshot when an element is gone", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    fake.staleRefs.add("e4");
    const result = await session.act([{ type: "click", ref: "e4" }], { settleMs: 0 });
    expect(result.failedStep?.error).toContain("fresh snapshot");
    expect(new StaleRefError("e4", "hint")).toBeInstanceOf(Error);
  });

  it("gives up on an element that stays disabled", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    fake.disabled = true;
    const result = await session.act([{ type: "click", ref: "e4" }], { settleMs: 0, actionabilityTimeoutMs: 120 });
    expect(result.failedStep?.error).toContain("is disabled");
    expect(new NotActionableError("e4", "is disabled")).toBeInstanceOf(Error);
  });

  it("selects a dropdown option by label and fails loudly when missing", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    const ok = await session.act([{ type: "select", ref: "e4", text: "Second" }], { settleMs: 0 });
    expect(ok.ok).toBe(true);
    fake.selectWorks = false;
    const bad = await session.act([{ type: "select", ref: "e4", text: "Nope" }], { settleMs: 0 });
    expect(bad.failedStep?.error).toContain('no option matching "Nope"');
  });

  it("scrolls without needing a ref", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    await session.act([{ type: "scroll", direction: "down", amount: 400 }], { settleMs: 0 });
    expect(fake.methodsCalled("Input.dispatchMouseEvent")[0]).toMatchObject({ type: "mouseWheel", deltaY: 400 });
  });

  it("extracts page content and caps long output with a hint", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    fake.evaluateValue = "hello world";
    const short = await session.extract({ format: "text" });
    expect(short.text).toBe("hello world");
    expect(short.truncated).toBe(false);

    fake.evaluateValue = "x".repeat(500);
    const long = await session.extract({ format: "text", maxChars: 100 });
    expect(long.truncated).toBe(true);
    expect(long.text).toContain("400 more characters");
    expect(long.text).toContain("maxChars");
  });

  it("takes a jpeg screenshot and reports an unchanged one instead of resending", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    const first = await session.screenshot();
    expect(first.format).toBe("jpeg");
    expect(first.base64).toBe("aaaabbbb");
    expect(fake.methodsCalled("Page.captureScreenshot")[0]).toMatchObject({ format: "jpeg", quality: 60 });

    const same = await session.screenshot({ skipIfUnchanged: true });
    expect(same.unchanged).toBe(true);
    expect(same.base64).toBeUndefined();

    fake.screenshotData = "ccccdddd";
    const changed = await session.screenshot({ skipIfUnchanged: true });
    expect(changed.unchanged).toBe(false);
  });

  it("clips a screenshot to one element", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    await session.screenshot({ ref: "e4" });
    expect(fake.methodsCalled("Page.captureScreenshot")[0]?.clip).toMatchObject({ x: 10, y: 100, width: 90 });
  });

  it("waits for a condition in one call and reports what never happened", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    fake.sent.length = 0;
    await expect(session.waitFor({ text: "Welcome" })).resolves.toMatchObject({ met: true, waitedMs: 120 });
    expect(fake.sent.filter((s) => s.method === "Runtime.evaluate")).toHaveLength(1);

    fake.waitMet = false;
    await expect(session.waitFor({ selector: "#done", timeoutMs: 150 })).rejects.toThrow(
      'selector "#done" appearing never happened',
    );
  });

  it("evaluates an expression and surfaces page errors", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    await session.navigate("https://example.test/page");
    fake.evaluateValue = 42;
    await expect(session.evaluate("1 + 41")).resolves.toBe(42);
    fake.evaluateThrows = true;
    await expect(session.evaluate("boom()")).rejects.toThrow("boom");
  });

  it("answers dialogs automatically and records them", async () => {
    const { fake, session } = newSession();
    fake.items = FORM_PAGE;
    const tab = await session.openTab();
    fake.emitEvent("Page.javascriptDialogOpening", { type: "confirm", message: "Delete everything?" }, tab.cdpSessionId);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.methodsCalled("Page.handleJavaScriptDialog")[0]).toMatchObject({ accept: false });
    expect(session.observed().dialogs[0]).toMatchObject({ type: "confirm", handledWith: "dismiss" });

    session.setDialogPolicy("accept");
    fake.emitEvent("Page.javascriptDialogOpening", { type: "alert", message: "Saved" }, tab.cdpSessionId);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.methodsCalled("Page.handleJavaScriptDialog")[1]).toMatchObject({ accept: true });
  });

  it("collects console output, failed requests, downloads and popup tabs", async () => {
    const { fake, session } = newSession();
    await session.openTab();
    fake.emitEvent("Log.entryAdded", { entry: { level: "error", text: "boom" } });
    fake.emitEvent("Network.loadingFailed", { documentURL: "https://x.test/a.js", errorText: "net::ERR_FAILED" });
    fake.emitEvent("Page.downloadWillBegin", { url: "https://x.test/f.pdf", suggestedFilename: "f.pdf" });
    fake.emitEvent("Target.targetCreated", { targetInfo: { type: "page", url: "https://popup.test", openerId: "t1" } });
    const seen = session.observed();
    expect(seen.console[0]).toMatchObject({ level: "error", text: "boom" });
    expect(seen.failedRequests[0]).toMatchObject({ errorText: "net::ERR_FAILED" });
    expect(seen.downloads[0]).toMatchObject({ fileName: "f.pdf" });
    expect(seen.newTabUrls).toEqual(["https://popup.test"]);
  });

  it("keeps observation buffers bounded", async () => {
    const fake = new FakeBrowser();
    const session = new AgentSession(new CdpProtocolClient(fake), { observationLimit: 3 });
    await session.openTab();
    for (let i = 0; i < 10; i++) fake.emitEvent("Log.entryAdded", { entry: { level: "info", text: `line ${i}` } });
    const seen = session.observed();
    expect(seen.console).toHaveLength(3);
    expect(seen.console.at(-1)?.text).toBe("line 9");
  });

  it("gives up on a command the browser never answers", async () => {
    const fake = new FakeBrowser();
    const session = new AgentSession(new CdpProtocolClient(fake), { commandTimeoutMs: 20, navigationTimeoutMs: 500 });
    const tab = await session.openTab();
    const original = fake.send.bind(fake);
    fake.send = (frame: string): void => {
      const msg = JSON.parse(frame) as { method: string };
      if (msg.method === "Page.navigate") return;
      original(frame);
    };
    await expect(session.navigate("https://slow.test", tab.tabId)).rejects.toThrow("Page.navigate timed out after 20ms");
  });

  it("fails a navigation that loads nothing before the navigation timeout", async () => {
    const fake = new FakeBrowser();
    const session = new AgentSession(new CdpProtocolClient(fake), { navigationTimeoutMs: 20 });
    const tab = await session.openTab();
    const original = fake.send.bind(fake);
    fake.send = (frame: string): void => {
      const msg = JSON.parse(frame) as { method: string; id: number };
      if (msg.method === "Page.navigate") {
        fake.reply(msg.id, { frameId: "f1" });
        return;
      }
      original(frame);
    };
    await expect(session.navigate("https://slow.test", tab.tabId)).rejects.toThrow("did not finish");
  });
});

describe("act step validation", () => {
  it("pauses on a wait step without touching the page", async () => {
    const calls: string[] = [];
    const send = async (method: string) => {
      calls.push(method);
      return {};
    };
    const started = Date.now();
    await performAction(send as never, "s1", new RefTable(), { type: "wait", ms: 60 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(calls).toEqual([]);
  });

  it("names the supported steps when the type is unknown", async () => {
    const send = async () => ({});
    await expect(
      performAction(send as never, "s1", new RefTable(), { type: "bogus" as never, ref: "e1" }),
    ).rejects.toThrow(/unknown step type "bogus"/);
  });

  it("tells the agent where refs come from", async () => {
    const send = async () => ({});
    await expect(performAction(send as never, "s1", new RefTable(), { type: "click" })).rejects.toThrow(
      /needs a ref from a snapshot/,
    );
  });
});

describe("tool definitions", () => {
  it("states the server's own idle ceiling on browser_session", () => {
    const [session] = agentToolDefinitions({ maxIdleMinutes: 5 });
    const idle = session.inputSchema.properties["idleMinutes"] as Record<string, unknown>;
    expect(idle["maximum"]).toBe(5);
    expect(String(idle["description"])).toContain("Maximum 5 minutes");
  });

  it("leaves the schema untouched when no ceiling is given", () => {
    const [session] = agentToolDefinitions();
    const idle = session.inputSchema.properties["idleMinutes"] as Record<string, unknown>;
    expect(idle["maximum"]).toBe(30);
  });
});

describe("waitForCondition", () => {
  it("bounds a caller-supplied wait to one minute", () => {
    expect(clampWaitTimeout(24 * 60 * 60 * 1000)).toBe(60_000);
    expect(clampWaitTimeout(60_001)).toBe(60_000);
    expect(clampWaitTimeout(Infinity)).toBe(10_000);
    expect(clampWaitTimeout(Number.NaN)).toBe(10_000);
    expect(clampWaitTimeout(undefined)).toBe(10_000);
    expect(clampWaitTimeout(-5)).toBe(0);
    expect(clampWaitTimeout(2_500)).toBe(2_500);
  });

  it("hands the page the clamped window, not the one the caller asked for", async () => {
    const refs = new RefTable();
    let asked: { timeoutMs?: number } | undefined;
    refs.world.call = (async (_send: unknown, _sid: unknown, _fn: unknown, arg: { timeoutMs?: number }) => {
      asked = arg;
      return { met: false };
    }) as typeof refs.world.call;
    await expect(
      waitForCondition((async () => ({})) as never, "s1", refs, { text: "never", timeoutMs: 24 * 60 * 60 * 1000 }),
    ).rejects.toThrow("waited 60000ms");
    expect(asked?.timeoutMs).toBe(60_000);
  });

  it("resolves as soon as the page reports the condition", async () => {
    const refs = new RefTable();
    refs.world.call = (async () => ({ met: true, waitedMs: 42 })) as typeof refs.world.call;
    await expect(waitForCondition((async () => ({})) as never, "s1", refs, { text: "soon" })).resolves.toEqual({
      met: true,
      waitedMs: 42,
    });
  });
});
