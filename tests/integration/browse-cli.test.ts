import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as chromeLauncher from "chrome-launcher";
import { CLI_ENTRY, requireBuiltCli } from "../helpers/harness.js";
import { startBrowseDaemon } from "../../src/server/browse/daemon.js";

const run = promisify(execFile);

const PAGE_HTML = `<!doctype html><html><head><title>CLI fixture</title></head><body>
<input id="note" value="old note">
<button id="save" type="button" onclick="document.getElementById('out').textContent = 'saved ' + document.getElementById('note').value">Save</button>
<div id="out">nothing saved</div>
</body></html>`;

const chromePath = (() => {
  try {
    return chromeLauncher.Launcher.getInstallations()[0] ?? null;
  } catch {
    return null;
  }
})();

describe.skipIf(!chromePath)("browse CLI", () => {
  let httpServer: Server;
  let baseUrl: string;
  let launched: chromeLauncher.LaunchedChrome;
  let endpoint: string;
  let workDir: string;
  let daemon: { stop: () => Promise<void> } | null = null;
  const session = `test-${process.pid}`;

  const cli = async (...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
    try {
      const { stdout, stderr } = await run(
        process.execPath,
        [CLI_ENTRY, "browse", ...args, "--session", session, "--endpoint", endpoint],
        { env: { ...process.env, HOME: workDir, BG_TOKEN: "" } },
      );
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
    }
  };

  beforeAll(async () => {
    requireBuiltCli();
    httpServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE_HTML);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    workDir = await mkdtemp(join(tmpdir(), "bg-cli-test-"));
    await mkdir(join(workDir, "chrome"), { recursive: true });
    launched = await chromeLauncher.launch({
      chromePath: chromePath!,
      userDataDir: join(workDir, "chrome"),
      chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--window-size=1280,720"],
      handleSIGINT: false,
    });
    const version = (await (await fetch(`http://127.0.0.1:${launched.port}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    endpoint = version.webSocketDebuggerUrl;

    // The runner blocks detached spawns, so the daemon the CLI would start is
    // started here instead; every CLI call below still goes over the socket.
    const { socketPathFor } = await import("../../src/server/browse/client.js");
    daemon = await startBrowseDaemon({ socketPath: socketPathFor(session), endpoint });
  }, 120_000);

  afterAll(async () => {
    await daemon?.stop().catch(() => undefined);
    if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await launched?.kill();
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("keeps one browser across separate CLI invocations", async () => {
    const opened = await cli("open", baseUrl);
    if (opened.code !== 0) throw new Error(`open failed: ${opened.stderr}`);
    expect(opened.code).toBe(0);
    expect(opened.stdout).toContain("CLI fixture");
    expect(opened.stdout).toMatch(/e\d textbox/);

    const snapshot = await cli("snapshot");
    expect(snapshot.stdout).toMatch(/e\d button "Save"/);

    const refOf = (out: string, needle: string): string =>
      out.split("\n").find((l) => l.includes(needle))!.split(" ")[0]!;

    const filled = await cli("fill", `@${refOf(snapshot.stdout, "textbox")}`, "written by cli");
    expect(filled.code).toBe(0);
    expect(filled.stdout).toContain("written by cli");

    const clicked = await cli("click", `@${refOf(snapshot.stdout, '"Save"')}`);
    expect(clicked.code).toBe(0);

    const extracted = await cli("extract", "--format", "text");
    expect(extracted.stdout).toContain("saved written by cli");
  }, 120_000);

  it("reports a stale ref with a non-zero exit code", async () => {
    await cli("open", baseUrl);
    const result = await cli("click", "@e999");
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("no longer on the page");
  }, 120_000);

  it("lists open sessions and closes on request", async () => {
    await cli("open", baseUrl);
    const listed = await run(process.execPath, [CLI_ENTRY, "browse", "sessions"], {
      env: { ...process.env, HOME: workDir },
    });
    expect(listed.stdout).toContain(session);

    const closed = await cli("close");
    expect(closed.stdout).toContain("closed");
    daemon = null;

    const after = await run(process.execPath, [CLI_ENTRY, "browse", "sessions"], {
      env: { ...process.env, HOME: workDir },
    });
    expect(after.stdout).not.toContain(session);
  }, 120_000);
});
