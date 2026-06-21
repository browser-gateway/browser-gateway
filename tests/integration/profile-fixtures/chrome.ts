/**
 * Test fixture: launch a real Chrome via chrome-launcher and return a puppeteer-core
 * Browser handle plus a cleanup function.
 *
 * Uses chrome-launcher (already in dependencies) to find Chrome.
 * Uses puppeteer-core (devDependencies) for the CDP client API.
 *
 * Tests skip themselves at runtime if no Chrome binary is found, so CI without
 * Chrome installed won't fail (it'll report skipped).
 */
import * as chromeLauncher from "chrome-launcher";
import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LaunchedChrome {
  browser: Browser;
  page: Page;
  cdp: CDPSession;
  close: () => Promise<void>;
}

export function findChromePath(): string | null {
  try {
    const installs = chromeLauncher.Launcher.getInstallations();
    return installs.length > 0 ? installs[0]! : null;
  } catch {
    return null;
  }
}

export async function launchChrome(): Promise<LaunchedChrome> {
  const chromePath = findChromePath();
  if (!chromePath) throw new Error("no Chrome installation found for tests");
  const userDataDir = await mkdtemp(join(tmpdir(), "bg-chrome-test-"));

  const launched = await chromeLauncher.launch({
    chromePath,
    userDataDir,
    chromeFlags: [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--password-store=basic",
      "--disable-quic",
      "--disable-features=DnsOverHttps,Translate,MediaRouter",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--remote-allow-origins=*",
      "--window-size=1280,720",
    ],
    handleSIGINT: false,
  });

  const wsEndpoint = await fetchWebSocketEndpoint(launched.port);

  const browser = await puppeteer.connect({
    browserWSEndpoint: wsEndpoint,
    defaultViewport: { width: 1280, height: 720 },
  });

  const page = await browser.newPage();
  const cdp = await page.createCDPSession();

  return {
    browser,
    page,
    cdp,
    close: async () => {
      try { await browser.disconnect(); } catch {}
      try { await launched.kill(); } catch {}
      try { await rm(userDataDir, { recursive: true, force: true }); } catch {}
    },
  };
}

async function fetchWebSocketEndpoint(port: number): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        const json = (await r.json()) as { webSocketDebuggerUrl: string };
        return json.webSocketDebuggerUrl;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Chrome /json/version did not respond on port ${port}`);
}
