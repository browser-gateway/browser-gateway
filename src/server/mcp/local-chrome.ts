import { platform } from "node:os";
import type { GatewayConfig } from "../../core/types.js";

// Match playwright-mcp's detection: headed on macOS/Windows, headless on Linux without DISPLAY
function shouldDefaultHeadless(): boolean {
  return platform() === "linux" && !process.env.DISPLAY;
}

interface LocalChromeInstance {
  port: number;
  cdpUrl: string;
  kill: () => Promise<void>;
}

let instance: LocalChromeInstance | null = null;

export async function setupLocalChrome(stderrLog?: (msg: string) => void, options?: { headless?: boolean }): Promise<GatewayConfig> {
  const log = stderrLog ?? ((msg: string) => process.stderr.write(msg + "\n"));

  let chromeLauncher;
  try {
    chromeLauncher = await import("chrome-launcher");
  } catch {
    log("chrome-launcher not available. Install it: npm install chrome-launcher");
    process.exit(1);
  }

  log("No config file found - starting in zero-config local mode");
  log("Detecting Chrome...");

  let chrome;
  try {
    const needsHeadless = options?.headless ?? shouldDefaultHeadless();

    const chromeFlags = [
      "--disable-dev-shm-usage",
    ];

    if (needsHeadless) {
      chromeFlags.unshift("--headless=new");
      log("Running in headless mode");
    } else {
      log("Running in headed mode (use --headless to disable)");
    }

    chrome = await chromeLauncher.launch({ chromeFlags });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Chrome not found: ${msg}`);
    log("");
    log("To use zero-config mode, install Google Chrome.");
    log("Or create a gateway.yml with remote providers:");
    log("  browser-gateway mcp --config gateway.yml");
    process.exit(1);
  }

  log(`Chrome launched on port ${chrome.port}`);

  const versionResp = await fetch(`http://localhost:${chrome.port}/json/version`);
  const versionData = (await versionResp.json()) as { webSocketDebuggerUrl: string };
  const cdpUrl = versionData.webSocketDebuggerUrl;

  log(`CDP endpoint: ${cdpUrl}`);

  instance = {
    port: chrome.port,
    cdpUrl,
    kill: async () => {
      await chrome.kill();
    },
  };

  process.on("exit", () => {
    try { chrome.kill(); } catch {}
  });

  let gatewayPort = parseInt(process.env.BG_PORT ?? "9500", 10);
  if (Number.isNaN(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) {
    gatewayPort = 9500;
  }

  return {
    version: 1,
    gateway: {
      port: gatewayPort,
      defaultStrategy: "priority-chain" as const,
      healthCheckInterval: 30000,
      connectionTimeout: 10000,
      shutdownDrainMs: 30000,
      cooldown: { defaultMs: 30000, failureThreshold: 0.5, minRequestVolume: 3 },
      sessions: { idleTimeoutMs: 300000, reconnectTimeoutMs: 300000 },
      queue: { maxSize: 20, timeoutMs: 30000 },
    },
    providers: {
      "local-chrome": {
        url: cdpUrl,
        limits: { maxConcurrent: 5 },
        priority: 1,
        weight: 1,
      },
    },
    webhooks: [],
    dashboard: { enabled: false },
    logging: { level: "info" as const },
  };
}

export function getLocalChromeInstance(): LocalChromeInstance | null {
  return instance;
}

export async function killLocalChrome(): Promise<void> {
  if (instance) {
    await instance.kill();
    instance = null;
  }
}
