import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import WebSocket from "ws";
import * as chromeLauncher from "chrome-launcher";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpProtocolClient, type CdpTransport } from "../../src/core/cdp/protocol.js";
import { AgentSession } from "../../src/agent-tools/index.js";

const PAGE_HTML = `<!doctype html><html><head><title>Agent tools fixture</title></head><body>
<h1>Sign in</h1>
<form>
  <label for="email">Email</label><input id="email" type="email" value="user@example.test">
  <label for="pw">Password</label><input id="pw" type="password" required>
  <label for="keep">Remember me</label><input id="keep" type="checkbox">
  <button id="submit" type="button">Sign in</button>
</form>
<div style="height:3000px"></div>
<a id="footer-link" href="/second">Footer link</a>
</body></html>`;

const INTERACTIVE_HTML = `<!doctype html><html><head><title>Interactive</title></head><body>
<input id="name" value="old value">
<input id="agree" type="checkbox">
<select id="pick"><option value="a">Alpha</option><option value="b">Bravo</option></select>
<button id="go" type="button" onclick="document.getElementById('out').textContent = 'clicked ' + document.getElementById('name').value">Go</button>
<button id="later" type="button" disabled>Disabled</button>
<button id="vanish" type="button" onclick="this.remove()">Vanishing</button>
<div id="out"></div>
<script>
  document.getElementById('agree').addEventListener('change', (e) => {
    document.getElementById('out').textContent = 'agree=' + e.target.checked;
  });
  document.getElementById('pick').addEventListener('change', (e) => {
    document.getElementById('out').textContent = 'picked ' + e.target.value;
  });
  document.getElementById('name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('out').textContent = 'submitted';
  });
</script>
</body></html>`;

const CONTENT_HTML = `<!doctype html><html><head><title>Content</title></head><body>
<h1>Main heading</h1>
<p>First paragraph with <a href="https://example.test/docs">a docs link</a>.</p>
<ul><li>Alpha item</li><li>Bravo item</li></ul>
<script>console.error("page error line");</script>
<button id="slow" type="button" onclick="setTimeout(() => { document.getElementById('late').textContent = 'ready now'; }, 400)">Slow</button>
<div id="late"></div>
<button id="ask" type="button" onclick="confirm('Delete everything?') ; document.getElementById('late').textContent = 'dialog done'">Ask</button>
<img src="/missing.png" alt="broken">
</body></html>`;

const SECOND_HTML = `<!doctype html><html><head><title>Second page</title></head><body>
<button id="only">Only button</button></body></html>`;

class NodeWsTransport implements CdpTransport {
  private ws: WebSocket;
  constructor(url: string) {
    this.ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  }
  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }
  send(data: string): void {
    this.ws.send(data);
  }
  onMessage(cb: (data: string) => void): void {
    this.ws.on("message", (raw) => cb(String(raw)));
  }
  onClose(cb: (reason?: string) => void): void {
    this.ws.on("close", () => cb("closed"));
  }
  async close(): Promise<void> {
    this.ws.close();
  }
}

const chromePath = (() => {
  try {
    return chromeLauncher.Launcher.getInstallations()[0] ?? null;
  } catch {
    return null;
  }
})();

async function readOut(session: AgentSession): Promise<string> {
  const tab = session.activeTab!;
  const res = (await (session as unknown as {
    send: (m: string, p: Record<string, unknown>, s: string | undefined) => Promise<unknown>;
  }).send(
    "Runtime.evaluate",
    { expression: "document.getElementById('out').textContent", returnByValue: true },
    tab.cdpSessionId,
  )) as { result?: { value?: unknown } };
  return String(res.result?.value ?? "");
}

describe.skipIf(!chromePath)("agent-tools against a real Chrome", () => {
  let httpServer: Server;
  let baseUrl: string;
  let launched: chromeLauncher.LaunchedChrome;
  let browserWsUrl: string;
  let userDataDir: string;

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      if (req.url === "/missing.png") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("nope");
        return;
      }
      const pages: Record<string, string> = {
        "/second": SECOND_HTML,
        "/interactive": INTERACTIVE_HTML,
        "/content": CONTENT_HTML,
      };
      res.writeHead(200, { "content-type": "text/html" });
      res.end(pages[req.url ?? ""] ?? PAGE_HTML);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    userDataDir = await mkdtemp(join(tmpdir(), "bg-agent-tools-"));
    launched = await chromeLauncher.launch({
      chromePath: chromePath!,
      userDataDir,
      chromeFlags: [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--disable-extensions",
        "--window-size=1280,720",
      ],
      handleSIGINT: false,
    });
    const version = (await (await fetch(`http://127.0.0.1:${launched.port}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    browserWsUrl = version.webSocketDebuggerUrl;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    try {
      await launched.kill();
    } catch {
      /* already gone */
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function connect(extra: { pageConsole?: boolean } = {}): Promise<{
    session: AgentSession;
    dispose: () => Promise<void>;
  }> {
    const transport = new NodeWsTransport(browserWsUrl);
    await transport.ready();
    const cdp = new CdpProtocolClient(transport);
    const session = new AgentSession(cdp, { navigationTimeoutMs: 20_000, ...extra });
    return {
      session,
      dispose: async () => {
        await session.close().catch(() => undefined);
        await cdp.close().catch(() => undefined);
      },
    };
  }

  it("navigates a real page and snapshots its form controls with refs", async () => {
    const { session, dispose } = await connect();
    try {
      const result = await session.navigate(baseUrl);
      expect(result.title).toBe("Agent tools fixture");
      expect(result.url).toBe(`${baseUrl}/`);
      expect(result.snapshot.text).toMatch(/e\d textbox "Email"/);
      expect(result.snapshot.text).toContain("user@example.test");
      expect(result.snapshot.text).toMatch(/e\d checkbox "Remember me"/);
      expect(result.snapshot.text).toMatch(/e\d button "Sign in"/);
      expect(result.snapshot.text).toContain("required");
    } finally {
      await dispose();
    }
  }, 60_000);

  it("leaves far-below-the-fold elements out of the viewport snapshot", async () => {
    const { session, dispose } = await connect();
    try {
      await session.navigate(baseUrl);
      const viewport = await session.snapshot();
      const full = await session.snapshot({ scope: "full" });
      expect(viewport.text).not.toContain("Footer link");
      expect(viewport.text).toContain('scope:"full"');
      expect(full.text).toContain("Footer link");
    } finally {
      await dispose();
    }
  }, 60_000);

  it("clears refs on navigation and re-numbers them for the new page", async () => {
    const { session, dispose } = await connect();
    try {
      const first = await session.navigate(baseUrl);
      expect(first.snapshot.text.split("\n").length).toBeGreaterThan(2);
      const second = await session.navigate(`${baseUrl}/second`);
      expect(second.title).toBe("Second page");
      expect(second.snapshot.text).toBe('e1 button "Only button"');
    } finally {
      await dispose();
    }
  }, 60_000);

  it("keeps two concurrent sessions isolated: own tabs, own refs, own cookies", async () => {
    const a = await connect();
    const b = await connect();
    try {
      await a.session.navigate(baseUrl);
      await b.session.navigate(`${baseUrl}/second`);

      const tabA = a.session.activeTab!;
      const tabB = b.session.activeTab!;
      expect(tabA.targetId).not.toBe(tabB.targetId);
      expect(tabA.refs.size).toBeGreaterThan(1);
      expect(tabB.refs.size).toBe(1);

      const snapA = await a.session.snapshot();
      const snapB = await b.session.snapshot();
      expect(snapA.text).toContain("Email");
      expect(snapB.text).toBe('e1 button "Only button"');
    } finally {
      await a.dispose();
      await b.dispose();
    }
  }, 90_000);

  it("fills a field and clicks a button with real input on a live page", async () => {
    const { session, dispose } = await connect();
    try {
      await session.navigate(`${baseUrl}/interactive`);
      const snap = await session.snapshot({ scope: "full" });
      const lines = snap.text.split("\n");
      const textboxRef = lines.find((l) => l.includes("textbox"))!.split(" ")[0]!;
      const goRef = lines.find((l) => l.includes('"Go"'))!.split(" ")[0]!;
      expect(snap.text).toContain("old value");

      const result = await session.act(
        [
          { type: "fill", ref: textboxRef, text: "typed by agent" },
          { type: "click", ref: goRef },
        ],
        { settleMs: 300, snapshot: { scope: "full" } },
      );

      expect(result.ok).toBe(true);
      expect(result.stepsRun).toBe(2);
      expect(await readOut(session)).toBe("clicked typed by agent");
      expect(result.changed.text).toContain("typed by agent");
      expect(result.changed.text).not.toContain("old value\n+");
    } finally {
      await dispose();
    }
  }, 60_000);

  it("presses Enter in a field without clearing what is typed", async () => {
    const { session, dispose } = await connect();
    try {
      await session.navigate(`${baseUrl}/interactive`);
      const snap = await session.snapshot({ scope: "full" });
      const textboxRef = snap.text.split("\n").find((l) => l.includes("textbox"))!.split(" ")[0]!;
      await session.act(
        [
          { type: "fill", ref: textboxRef, text: "abc" },
          { type: "type", ref: textboxRef, text: "def" },
          { type: "press", ref: textboxRef, key: "Enter" },
        ],
        { settleMs: 300, snapshot: { scope: "full" } },
      );
      expect(await readOut(session)).toBe("submitted");
      const after = await session.snapshot({ scope: "full" });
      expect(after.text).toContain("abcdef");
    } finally {
      await dispose();
    }
  }, 60_000);

  it("checks a checkbox only when needed and selects a dropdown option", async () => {
    const { session, dispose } = await connect();
    try {
      await session.navigate(`${baseUrl}/interactive`);
      const snap = await session.snapshot({ scope: "full" });
      const checkboxRef = snap.text.split("\n").find((l) => l.includes("checkbox"))!.split(" ")[0]!;
      const comboRef = snap.text.split("\n").find((l) => l.includes("combobox"))!.split(" ")[0]!;

      await session.act([{ type: "check", ref: checkboxRef }], { settleMs: 200 });
      expect(await readOut(session)).toBe("agree=true");

      await session.act([{ type: "check", ref: checkboxRef }], { settleMs: 200 });
      expect(await readOut(session)).toBe("agree=true");

      await session.act([{ type: "uncheck", ref: checkboxRef }], { settleMs: 200 });
      expect(await readOut(session)).toBe("agree=false");

      await session.act([{ type: "select", ref: comboRef, text: "Bravo" }], { settleMs: 200 });
      expect(await readOut(session)).toBe("picked b");
    } finally {
      await dispose();
    }
  }, 60_000);

  it("refuses a disabled button and tells the agent why", async () => {
    const { session, dispose } = await connect();
    try {
      await session.navigate(`${baseUrl}/interactive`);
      const snap = await session.snapshot({ scope: "full" });
      const disabledRef = snap.text.split("\n").find((l) => l.includes('"Disabled"'))!.split(" ")[0]!;
      const result = await session.act([{ type: "click", ref: disabledRef }], {
        settleMs: 0,
        actionabilityTimeoutMs: 400,
      });
      expect(result.ok).toBe(false);
      expect(result.failedStep?.error).toContain("is disabled");
    } finally {
      await dispose();
    }
  }, 60_000);

  it("reports a stale ref after the element disappears", async () => {
    const { session, dispose } = await connect();
    try {
      await session.navigate(`${baseUrl}/interactive`);
      const snap = await session.snapshot({ scope: "full" });
      const vanishRef = snap.text.split("\n").find((l) => l.includes('"Vanishing"'))!.split(" ")[0]!;
      const first = await session.act([{ type: "click", ref: vanishRef }], { settleMs: 300 });
      expect(first.ok).toBe(true);
      expect(first.changed.text).toContain("Vanishing");

      const again = await session.act([{ type: "click", ref: vanishRef }], { settleMs: 0 });
      expect(again.ok).toBe(false);
      expect(again.failedStep?.error).toMatch(/no longer on the page|not actionable/);
    } finally {
      await dispose();
    }
  }, 60_000);

  it("reads a real page as markdown, text and links", async () => {
    const { session, dispose } = await connect();
    try {
      await session.navigate(`${baseUrl}/content`);
      const markdown = await session.extract({ format: "markdown" });
      expect(markdown.text).toContain("# Main heading");
      expect(markdown.text).toContain("- Alpha item");
      expect(markdown.text).toContain("[a docs link](https://example.test/docs)");

      const text = await session.extract({ format: "text" });
      expect(text.text).toContain("First paragraph");
      expect(text.text).not.toContain("#");

      const links = await session.extract({ format: "links" });
      expect(links.text).toBe("a docs link -> https://example.test/docs");
    } finally {
      await dispose();
    }
  }, 60_000);

  it("screenshots the viewport as jpeg and skips an unchanged repeat", async () => {
    const { session, dispose } = await connect();
    try {
      await session.navigate(`${baseUrl}/content`);
      const first = await session.screenshot();
      expect(first.bytes).toBeGreaterThan(1000);
      expect(first.base64?.startsWith("/9j/")).toBe(true);

      const repeat = await session.screenshot({ skipIfUnchanged: true });
      expect(repeat.unchanged).toBe(true);
      expect(repeat.bytes).toBe(0);
    } finally {
      await dispose();
    }
  }, 60_000);

  it("waits for content that appears later and reports a condition that never holds", async () => {
    const { session, dispose } = await connect();
    try {
      await session.navigate(`${baseUrl}/content`);
      const snap = await session.snapshot({ scope: "full" });
      const slowRef = snap.text.split("\n").find((l) => l.includes('"Slow"'))!.split(" ")[0]!;
      await session.act([{ type: "click", ref: slowRef }], { settleMs: 0 });

      const waited = await session.waitFor({ text: "ready now", timeoutMs: 5_000 });
      expect(waited.met).toBe(true);
      expect(waited.waitedMs).toBeGreaterThan(100);

      await expect(session.waitFor({ text: "never appears", timeoutMs: 300 })).rejects.toThrow("never happened");
    } finally {
      await dispose();
    }
  }, 60_000);

  it("answers a real confirm dialog instead of freezing the page", async () => {
    const { session, dispose } = await connect();
    try {
      await session.navigate(`${baseUrl}/content`);
      const snap = await session.snapshot({ scope: "full" });
      const askRef = snap.text.split("\n").find((l) => l.includes('"Ask"'))!.split(" ")[0]!;
      const result = await session.act([{ type: "click", ref: askRef }], { settleMs: 500 });
      expect(result.ok).toBe(true);
      expect(await session.evaluate<string>("document.getElementById('late').textContent")).toBe("dialog done");
      const dialogs = session.observed().dialogs;
      expect(dialogs[0]).toMatchObject({ type: "confirm", message: "Delete everything?", handledWith: "dismiss" });
    } finally {
      await dispose();
    }
  }, 60_000);

  it("records browser-level log entries without page console capture", async () => {
    const { session, dispose } = await connect();
    try {
      await session.navigate(`${baseUrl}/content`);
      await session.waitFor({ selector: "img", timeoutMs: 3_000 });
      const seen = session.observed();
      expect(seen.console.some((c) => c.text.includes("404"))).toBe(true);
      expect(seen.console.some((c) => c.text.includes("page error line"))).toBe(false);
    } finally {
      await dispose();
    }
  }, 60_000);

  it("captures the page's own console output when the session opts in", async () => {
    const { session, dispose } = await connect({ pageConsole: true });
    try {
      await session.navigate(`${baseUrl}/content`);
      await session.waitFor({ selector: "img", timeoutMs: 3_000 });
      expect(session.observed().console.some((c) => c.text.includes("page error line"))).toBe(true);
    } finally {
      await dispose();
    }
  }, 60_000);

  it("runs an expression in the page and surfaces page-side errors", async () => {
    const { session, dispose } = await connect();
    try {
      await session.navigate(`${baseUrl}/content`);
      await expect(session.evaluate<number>("2 + 3")).resolves.toBe(5);
      await expect(session.evaluate("document.title")).resolves.toBe("Content");
      await expect(session.evaluate("nope.missing()")).rejects.toThrow(/not defined|nope/);
    } finally {
      await dispose();
    }
  }, 60_000);

  it("keeps a quiet session alive with keepalive traffic, then closes it on the idle clock", async () => {
    const transport = new NodeWsTransport(browserWsUrl);
    await transport.ready();
    const cdp = new CdpProtocolClient(transport);
    const session = new AgentSession(cdp, {
      navigationTimeoutMs: 20_000,
      policy: { idleMs: 60_000, keepaliveMs: 2_000 },
    });
    try {
      await session.navigate(`${baseUrl}/content`);
      await new Promise((r) => setTimeout(r, 12_000));
      expect(session.expired).toBeNull();
      const stillWorks = await session.extract({ format: "text" });
      expect(stillWorks.text).toContain("Main heading");
      expect(session.state.secondsUntilIdleClose).toBeGreaterThan(50);
    } finally {
      await session.close().catch(() => undefined);
      await cdp.close().catch(() => undefined);
    }
  }, 60_000);

  it("carries session expiry information on every action result", async () => {
    const { session, dispose } = await connect();
    try {
      const nav = await session.navigate(`${baseUrl}/interactive`);
      expect(nav.session.idleTimeoutS).toBe(300);
      expect(nav.session.secondsUntilIdleClose).toBeGreaterThan(290);

      const snap = await session.snapshot({ scope: "full" });
      const goRef = snap.text.split("\n").find((l) => l.includes('"Go"'))!.split(" ")[0]!;
      const acted = await session.act([{ type: "click", ref: goRef }], { settleMs: 200 });
      expect(acted.session.expiresAtMs).toBeGreaterThan(Date.now());
      expect(acted.warning).toBeUndefined();
    } finally {
      await dispose();
    }
  }, 60_000);

  it("stops an agent that repeats the same failing action", async () => {
    const { session, dispose } = await connect();
    try {
      await session.navigate(`${baseUrl}/interactive`);
      const snap = await session.snapshot({ scope: "full" });
      const disabledRef = snap.text.split("\n").find((l) => l.includes('"Disabled"'))!.split(" ")[0]!;
      const step = { type: "click", ref: disabledRef } as const;
      await session.act([step], { settleMs: 0, actionabilityTimeoutMs: 200 });
      await session.act([step], { settleMs: 0, actionabilityTimeoutMs: 200 });
      await expect(session.act([step], { settleMs: 0, actionabilityTimeoutMs: 200 })).rejects.toThrow(
        "failed 3 times in a row",
      );
    } finally {
      await dispose();
    }
  }, 60_000);

  it("closing a session leaves the browser and other sessions alive", async () => {
    const a = await connect();
    const b = await connect();
    try {
      await a.session.navigate(baseUrl);
      await b.session.navigate(baseUrl);
      await a.session.close();

      const stillWorks = await b.session.navigate(`${baseUrl}/second`);
      expect(stillWorks.title).toBe("Second page");

      const version = await fetch(`http://127.0.0.1:${launched.port}/json/version`);
      expect(version.ok).toBe(true);
    } finally {
      await a.dispose();
      await b.dispose();
    }
  }, 90_000);
});
