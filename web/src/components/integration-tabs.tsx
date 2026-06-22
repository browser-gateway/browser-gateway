"use client";

/**
 * Tabbed quickstart panel showing how to connect to browser-gateway from each
 * popular client. Tabs:
 *
 *   - Puppeteer (Node, Google) — most common CDP client
 *   - Playwright (Node, Microsoft) — connectOverCDP
 *   - Stagehand (Node, Browserbase) — natural-language layer
 *   - browser-use (Python) — AI agent framework
 *   - Raw CDP (curl + wscat) — lowest-level path
 *
 * Each tab carries the official logo, a syntax-highlighted code example, and
 * a copy button (via CodeBlock).
 */
import { useState } from "react";
import { Terminal } from "lucide-react";
import { CodeBlock, type CodeLang } from "./code-block";
import { useGatewayToken } from "./token-autofill";
import { maskToken } from "@/lib/connect-url";

interface Integration {
  id: string;
  label: string;
  /** Image path in /public/integrations/, OR null to use the icon. */
  logo: string | null;
  /** Lucide icon used when logo is null. */
  Icon?: typeof Terminal;
  lang: CodeLang;
  filename: string;
  /** Code template. `${gw}` = WS host (e.g. ws://localhost:9500), `${query}` = ready-made `?profile=...&token=...` (or empty). */
  code: (gw: string, query: string) => string;
}

const INTEGRATIONS: Integration[] = [
  {
    id: "puppeteer",
    label: "Puppeteer",
    logo: "/web/integrations/puppeteer.png",
    lang: "typescript",
    filename: "puppeteer.ts",
    code: (gw, query) => `import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserWSEndpoint: "${gw}/v1/connect${query}",
});

const page = await browser.newPage();
await page.goto("https://example.com");

const title = await page.title();
console.log(title);

await browser.disconnect();`,
  },
  {
    id: "playwright",
    label: "Playwright",
    logo: "/web/integrations/playwright.svg",
    lang: "typescript",
    filename: "playwright.ts",
    code: (gw, query) => `import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP(
  "${gw}/v1/connect${query}",
);

const context = browser.contexts()[0];
const page = await context.newPage();
await page.goto("https://example.com");

console.log(await page.title());

await browser.close();`,
  },
  {
    id: "stagehand",
    label: "Stagehand",
    logo: "/web/integrations/stagehand.png",
    lang: "typescript",
    filename: "stagehand.ts",
    code: (gw, query) => `import { Stagehand } from "@browserbasehq/stagehand";

const stagehand = new Stagehand({
  env: "LOCAL",
  localBrowserLaunchOptions: {
    cdpUrl: "${gw}/v1/connect${query}",
  },
});

await stagehand.init();

await stagehand.page.goto("https://example.com");
await stagehand.page.act("click the first link");

await stagehand.close();`,
  },
  {
    id: "browser-use",
    label: "browser-use",
    logo: "/web/integrations/browser-use.png",
    lang: "python",
    filename: "main.py",
    code: (gw, query) => `from browser_use import Agent, Browser, BrowserConfig
from langchain_openai import ChatOpenAI

browser = Browser(config=BrowserConfig(
    cdp_url="${gw}/v1/connect${query}",
))

agent = Agent(
    task="Open example.com and summarise the page.",
    llm=ChatOpenAI(model="gpt-4o"),
    browser=browser,
)
await agent.run()
await browser.close()`,
  },
  {
    id: "cdp",
    label: "Raw CDP",
    logo: null,
    Icon: Terminal,
    lang: "bash",
    filename: "raw-cdp.sh",
    code: (gw, query) => `# Connect with any WebSocket client. The gateway proxies every CDP byte
# after the upgrade handshake — exactly like a direct Chrome WS.
npx wscat -c "${gw}/v1/connect${query}"

# Once open, send any CDP command:
{"id":1,"method":"Target.getTargets"}`,
  },
];

interface IntegrationTabsProps {
  /** Base WS URL — e.g. "ws://localhost:9500". Derived from window.location at render time. */
  wsBase?: string;
  /** Whether the gateway requires a token. If so, examples include `&token=...`. */
  authEnabled?: boolean;
  /** Optional profile id to include in the URL — omit for the bare connect URL. */
  profileId?: string;
}

export function IntegrationTabs({ wsBase, authEnabled, profileId }: IntegrationTabsProps) {
  const [active, setActive] = useState<string>("puppeteer");
  const realToken = useGatewayToken();
  const gw = wsBase ?? deriveWsBase();

  // The display version has the token masked (`abc•••xyz`). The copy version
  // is the real token, baked into a small JSX trampoline (see CodeBlockWithRealCopy below).
  const displayParts: string[] = [];
  const copyParts: string[] = [];
  if (profileId) {
    const p = `profile=${encodeURIComponent(profileId)}`;
    displayParts.push(p);
    copyParts.push(p);
  }
  if (authEnabled) {
    if (realToken) {
      displayParts.push(`token=${maskToken(realToken)}`);
      copyParts.push(`token=${realToken}`);
    } else {
      displayParts.push("token=YOUR_BG_TOKEN");
      copyParts.push("token=YOUR_BG_TOKEN");
    }
  }
  const displayQuery = displayParts.length > 0 ? "?" + displayParts.join("&") : "";
  const copyQuery = copyParts.length > 0 ? "?" + copyParts.join("&") : "";

  const current = INTEGRATIONS.find((i) => i.id === active) ?? INTEGRATIONS[0];

  return (
    <div className="space-y-3">
      <div className="flex gap-1 flex-wrap" role="tablist">
        {INTEGRATIONS.map((it) => {
          const isActive = it.id === active;
          return (
            <button
              key={it.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActive(it.id)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md border text-[12px] font-medium transition-colors ${
                isActive
                  ? "bg-foreground/10 border-foreground/30 text-foreground"
                  : "bg-transparent border-border/30 text-muted-foreground hover:bg-muted/30 hover:text-foreground"
              }`}
            >
              {it.logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={it.logo}
                  alt={`${it.label} logo`}
                  width={16}
                  height={16}
                  className="size-4 object-contain"
                />
              ) : it.Icon ? (
                <it.Icon className="size-3.5" />
              ) : null}
              <span>{it.label}</span>
            </button>
          );
        })}
      </div>

      <CodeBlock
        code={current!.code(gw, displayQuery)}
        copyValue={current!.code(gw, copyQuery)}
        lang={current!.lang}
        filename={current!.filename}
      />

      <p className="text-[11px] text-muted-foreground">
        {profileId ? (
          <>
            Connecting with{" "}
            <code className="font-mono text-foreground/80 bg-muted px-1 py-0.5 rounded text-[10.5px]">
              ?profile={profileId}
            </code>
            {" "}captures cookies and per-origin storage when the session ends,
            and replays them next time.{" "}
          </>
        ) : (
          <>
            Add{" "}
            <code className="font-mono text-foreground/80 bg-muted px-1 py-0.5 rounded text-[10.5px]">
              ?profile=&lt;id&gt;
            </code>{" "}
            to persist cookies and storage between sessions.{" "}
          </>
        )}
        {authEnabled && (
          <>
            The token is shown masked — the copy button copies the real value.
          </>
        )}
      </p>
    </div>
  );
}

function deriveWsBase(): string {
  if (typeof window === "undefined") return "ws://localhost:9500";
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  // Heuristic: the gateway port is the API origin. In dev mode the dashboard
  // hot-reloads on :9501 but the gateway it talks to is :9500.
  const host = window.location.host.includes("9501")
    ? window.location.host.replace("9501", "9500")
    : window.location.host;
  return `${scheme}://${host}`;
}
