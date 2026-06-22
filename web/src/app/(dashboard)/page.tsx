"use client";

/**
 * Overview = "Get Started + at-a-glance gateway state".
 *
 * Layout decisions (after user feedback):
 *   1. Stats row at the very top — what's the gateway doing right now?
 *   2. Tabbed content below: Connect (the most important — how to use it),
 *      REST API, and Provider Health. Tabs prevent the page from being a
 *      long scroll where the "active connections" detail is buried.
 *
 * Previously this page had connection + REST sections AT THE TOP and stats
 * in the middle. New users had to scroll past sample code to learn whether
 * their gateway was even running.
 */
import { useEffect, useState } from "react";
import { Server, Copy, Check, Link2, Code2, Activity } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IntegrationTabs } from "@/components/integration-tabs";
import { useGatewayToken, useAuthEnabled } from "@/components/token-autofill";
import { buildConnectUrl, maskUrlToken } from "@/lib/connect-url";
import type { GatewayStatus } from "@/lib/api";
import { fetchStatus } from "@/lib/api";

export default function OverviewPage() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const data = await fetchStatus();
        setStatus(data);
        setError(null);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
        <Card className="glass">
          <CardContent className="p-6">
            <p className="text-sm text-destructive">Unable to connect to gateway API</p>
            <p className="text-sm text-muted-foreground mt-1">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="space-y-6">
        <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
        <div className="grid gap-4 sm:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="glass">
              <CardContent className="p-5">
                <div className="h-4 w-24 bg-muted rounded animate-pulse" />
                <div className="h-8 w-16 bg-muted rounded mt-3 animate-pulse" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const healthyCount = status.providers.filter((b) => b.healthy).length;

  if (status.providers.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gateway status, active connections, and provider health at a glance.
          </p>
        </div>
        <Card className="glass">
          <CardContent className="p-8 flex flex-col items-center text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
              <Server className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
            </div>
            <p className="text-lg font-medium">Get started</p>
            <p className="text-sm text-muted-foreground mt-1.5 max-w-md">
              Connect your remote browser services to start routing. Go to the{" "}
              <a href="/web/providers/" className="text-foreground underline underline-offset-4 hover:text-foreground/80">
                Providers
              </a>{" "}
              page to add your first browser provider.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Gateway status, active browser sessions, and provider health.
        </p>
      </div>

      {status.status === "shutting_down" && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="px-5 py-3">
            <p className="text-sm font-medium text-destructive">Gateway is shutting down</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Active sessions are draining. New connections are being rejected.
            </p>
          </CardContent>
        </Card>
      )}

      {/* 1. Stats up top — answer "what's happening right now?" first */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Active Sessions"
          value={status.activeSessions}
          hint={status.activeSessions === 0 ? "idle" : "in flight"}
        />
        <StatCard
          label="Queued"
          value={status.queueSize}
          hint={status.queueSize > 0 ? "waiting for a free slot" : "no requests waiting"}
        />
        <StatCard
          label="Providers"
          value={healthyCount}
          suffix={`/${status.providers.length}`}
          hint={healthyCount === status.providers.length ? "all healthy" : "some degraded"}
        />
        <StatCard label="Strategy" valueText={status.strategy} hint="routing strategy" />
      </div>

      {/* 2. Tabbed work area below — pick the thing you came here to do */}
      <Tabs defaultValue="connect" className="w-full">
        <TabsList variant="line" className="border-b border-border/40 rounded-none gap-4 px-0 mb-4">
          <TabsTrigger value="connect" className="px-1 pb-2 data-active:!text-foreground gap-1.5">
            <Link2 className="size-3.5" />
            Connect
          </TabsTrigger>
          <TabsTrigger value="rest" className="px-1 pb-2 data-active:!text-foreground gap-1.5">
            <Code2 className="size-3.5" />
            REST API
          </TabsTrigger>
          <TabsTrigger value="providers" className="px-1 pb-2 data-active:!text-foreground gap-1.5">
            <Activity className="size-3.5" />
            Providers
          </TabsTrigger>
        </TabsList>

        <TabsContent value="connect" className="space-y-4 mt-2">
          <ConnectionEndpoint />
          <Card className="glass">
            <CardContent className="px-5 py-4 space-y-3 min-w-0">
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Quick start</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Copy a snippet for your favorite client. Each example connects through this gateway and inherits its routing + failover. To persist cookies and storage across runs, see{" "}
                  <a href="/web/profiles/" className="text-foreground underline underline-offset-2 hover:text-foreground/80">
                    Profiles
                  </a>{" "}
                  and add{" "}
                  <code className="font-mono text-foreground/80 bg-muted px-1 py-0.5 rounded text-[10.5px]">
                    ?profile=&lt;id&gt;
                  </code>{" "}
                  to the URL.
                </p>
              </div>
              <IntegrationTabs authEnabled />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rest" className="mt-2">
          <RestApiEndpoints />
        </TabsContent>

        <TabsContent value="providers" className="mt-2">
          <div className="space-y-2">
            {status.providers.map((provider) => (
              <Card key={provider.id} className="glass glass-hover">
                <CardContent className="px-5 py-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className={`h-2 w-2 rounded-full ${
                          provider.healthy ? "bg-foreground" : "bg-destructive animate-pulse"
                        }`}
                      />
                      <span className="text-sm font-medium font-mono">{provider.id}</span>
                      <span className="text-xs text-muted-foreground">P{provider.priority}</span>
                    </div>

                    <div className="flex items-center gap-8">
                      <div className="text-right">
                        <span className="text-sm font-mono tabular-nums">
                          {provider.active}
                          <span className="text-muted-foreground">
                            /{provider.maxConcurrent ?? "∞"}
                          </span>
                        </span>
                        <p className="text-xs text-muted-foreground">connections</p>
                      </div>

                      <div className="text-right min-w-[60px]">
                        <span className="text-sm font-mono tabular-nums">
                          {provider.avgLatencyMs}
                        </span>
                        <span className="text-xs text-muted-foreground">ms</span>
                        <p className="text-xs text-muted-foreground">latency</p>
                      </div>

                      <div className="text-right min-w-[50px]">
                        <span className="text-sm font-mono tabular-nums">
                          {provider.totalConnections}
                        </span>
                        <p className="text-xs text-muted-foreground">total</p>
                      </div>

                      {provider.cooldownUntil && (
                        <Badge variant="destructive" className="text-xs">cooldown</Badge>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard(props: {
  label: string;
  value?: number;
  valueText?: string;
  suffix?: string;
  hint?: string;
}) {
  return (
    <Card className="glass">
      <CardContent className="p-5">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{props.label}</p>
        {props.valueText ? (
          <p className="text-sm font-mono mt-3 text-foreground">{props.valueText}</p>
        ) : (
          <p className="text-3xl font-semibold font-mono mt-2 tabular-nums">
            {props.value}
            {props.suffix && (
              <span className="text-base text-muted-foreground font-normal">{props.suffix}</span>
            )}
          </p>
        )}
        {props.hint && <p className="text-xs text-muted-foreground mt-0.5">{props.hint}</p>}
      </CardContent>
    </Card>
  );
}

function RestApiEndpoints() {
  const [copied, setCopied] = useState<string | null>(null);

  let baseUrl = "http://localhost:9500";
  if (typeof window !== "undefined") {
    const protocol = window.location.protocol;
    const host = window.location.hostname;
    const port = window.location.port;
    const portSuffix =
      (protocol === "https:" && port === "443") ||
      (protocol === "http:" && port === "80") ||
      !port
        ? ""
        : `:${port}`;
    baseUrl = `${protocol}//${host}${portSuffix}`;
  }

  const copy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const endpoints = [
    {
      id: "screenshot",
      method: "POST",
      path: "/v1/screenshot",
      desc: "Capture a screenshot of any URL",
      example: `curl -X POST ${baseUrl}/v1/screenshot -H "Content-Type: application/json" -d '{"url":"https://example.com"}' --output screenshot.png`,
    },
    {
      id: "content",
      method: "POST",
      path: "/v1/content",
      desc: "Extract page content as markdown, HTML, or text",
      example: `curl -X POST ${baseUrl}/v1/content -H "Content-Type: application/json" -d '{"url":"https://example.com","formats":["markdown"]}'`,
    },
    {
      id: "scrape",
      method: "POST",
      path: "/v1/scrape",
      desc: "Extract data using CSS selectors or full-page formats",
      example: `curl -X POST ${baseUrl}/v1/scrape -H "Content-Type: application/json" -d '{"url":"https://example.com","selectors":[{"name":"title","selector":"h1"}]}'`,
    },
  ];

  return (
    <Card className="glass">
      <CardContent className="px-5 py-4 space-y-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">REST API</p>
          <p className="text-xs text-muted-foreground mt-1">
            Simple HTTP endpoints for screenshots, content extraction, and scraping. Each request uses the routing engine automatically.
          </p>
        </div>

        <div className="space-y-2">
          {endpoints.map((ep) => (
            <div key={ep.id} className="flex items-center gap-2 text-xs">
              <Badge variant="secondary" className="font-mono text-[10px] px-1.5 py-0 shrink-0">
                {ep.method}
              </Badge>
              <code className="font-mono text-sm text-foreground/90">{ep.path}</code>
              <span className="text-muted-foreground truncate hidden sm:inline">{ep.desc}</span>
              <button
                onClick={() => copy(ep.example, ep.id)}
                className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                aria-label={`Copy curl example for ${ep.path}`}
              >
                {copied === ep.id ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ConnectionEndpoint() {
  const [copied, setCopied] = useState(false);
  const authEnabled = useAuthEnabled();
  const realToken = useGatewayToken();

  // Real URL — what we copy. Masked URL — what we show on screen.
  const realUrl = buildConnectUrl(undefined, authEnabled ? realToken : null);
  const displayUrl = maskUrlToken(realUrl);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(realUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore — clipboard may be unavailable over HTTP
    }
  }

  return (
    <Card className="glass">
      <CardContent className="px-5 py-4 space-y-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Connection Endpoint</p>
          <p className="text-xs text-muted-foreground mt-1">
            Use this URL in your Playwright, Puppeteer, or any WebSocket client to connect through the gateway. The token is shown masked — Copy writes the real value.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <code className="flex-1 text-sm font-mono bg-muted/50 rounded-md px-3 py-2 truncate">
            {displayUrl}
          </code>
          <Button
            variant="secondary"
            size="sm"
            className="h-8 text-xs gap-1.5 shrink-0"
            onClick={handleCopy}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
