"use client";

import { useEffect, useState } from "react";
import { Server, Copy, Check } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
      } catch (err: any) {
        setError(err.message);
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
              Connect your remote browser services to start routing. Go to the <a href="/web/providers/" className="text-foreground underline underline-offset-4 hover:text-foreground/80">Providers</a> page to add your first browser provider.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Gateway status, active browser sessions, and provider health.
        </p>
      </div>

      {status.status === "shutting_down" && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="px-5 py-3">
            <p className="text-sm font-medium text-destructive">
              Gateway is shutting down
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Active sessions are draining. New connections are being rejected.
            </p>
          </CardContent>
        </Card>
      )}

      <ConnectionEndpoint />

      <RestApiEndpoints />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="glass">
          <CardContent className="p-5">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Active Sessions
            </p>
            <p className="text-3xl font-semibold font-mono mt-2 tabular-nums">
              {status.activeSessions}
            </p>
          </CardContent>
        </Card>

        <Card className="glass">
          <CardContent className="p-5">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Queued
            </p>
            <p className="text-3xl font-semibold font-mono mt-2 tabular-nums">
              {status.queueSize}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {status.queueSize > 0 ? "waiting for a free slot" : "no requests waiting"}
            </p>
          </CardContent>
        </Card>

        <Card className="glass">
          <CardContent className="p-5">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Providers
            </p>
            <p className="text-3xl font-semibold font-mono mt-2 tabular-nums">
              {healthyCount}
              <span className="text-base text-muted-foreground font-normal">
                /{status.providers.length}
              </span>
            </p>
          </CardContent>
        </Card>

        <Card className="glass">
          <CardContent className="p-5">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Strategy
            </p>
            <p className="text-sm font-mono mt-3 text-muted-foreground">
              {status.strategy}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Providers</h2>
        <div className="space-y-2">
          {status.providers.map((provider) => (
            <Card key={provider.id} className="glass glass-hover">
              <CardContent className="px-5 py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-2 w-2 rounded-full ${
                        provider.healthy
                          ? "bg-emerald-500"
                          : "bg-red-500 animate-pulse"
                      }`}
                    />
                    <span className="text-sm font-medium font-mono">
                      {provider.id}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      P{provider.priority}
                    </span>
                  </div>

                  <div className="flex items-center gap-8">
                    <div className="text-right">
                      <span className="text-sm font-mono tabular-nums">
                        {provider.active}
                        <span className="text-muted-foreground">
                          /{provider.maxConcurrent ?? "\u221E"}
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
                      <Badge variant="destructive" className="text-xs">
                        cooldown
                      </Badge>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
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
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            REST API
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Simple HTTP endpoints for screenshots, content extraction, and
            scraping. Each request uses the routing engine automatically.
          </p>
        </div>

        <div className="space-y-2">
          {endpoints.map((ep) => (
            <div
              key={ep.id}
              className="flex items-center gap-2 text-xs"
            >
              <Badge
                variant="secondary"
                className="font-mono text-[10px] px-1.5 py-0 shrink-0"
              >
                {ep.method}
              </Badge>
              <code className="font-mono text-sm text-foreground/90">
                {ep.path}
              </code>
              <span className="text-muted-foreground truncate hidden sm:inline">
                {ep.desc}
              </span>
              <button
                onClick={() => copy(ep.example, ep.id)}
                className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
              >
                {copied === ep.id ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ConnectionEndpoint() {
  const [copied, setCopied] = useState<string | null>(null);

  let wsUrl = "ws://localhost:9500/v1/connect";
  if (typeof window !== "undefined") {
    const isSecure = window.location.protocol === "https:";
    const protocol = isSecure ? "wss" : "ws";
    const host = window.location.hostname;
    const port = window.location.port;
    const portSuffix = (isSecure && port === "443") || (!isSecure && port === "80") || !port ? "" : `:${port}`;
    wsUrl = `${protocol}://${host}${portSuffix}/v1/connect`;
  }

  const copy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <Card className="glass">
      <CardContent className="px-5 py-4 space-y-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Connection Endpoint</p>
          <p className="text-xs text-muted-foreground mt-1">
            Use this URL in your Playwright, Puppeteer, or any WebSocket client to connect through the gateway.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <code className="flex-1 text-sm font-mono bg-muted/50 rounded-md px-3 py-2 truncate">
            {wsUrl}
          </code>
          <Button
            variant="secondary"
            size="sm"
            className="h-8 text-xs gap-1.5 shrink-0"
            onClick={() => copy(wsUrl, "ws")}
          >
            {copied === "ws" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied === "ws" ? "Copied" : "Copy"}
          </Button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 text-xs text-muted-foreground">
          <div className="space-y-1.5">
            <p className="font-medium text-foreground/80">Playwright</p>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 bg-muted/30 rounded px-2 py-1 font-mono truncate text-[11px]">
                chromium.connect('{wsUrl}')
              </code>
              <button onClick={() => copy(`const browser = await chromium.connect('${wsUrl}');`, "pw")} className="shrink-0 text-muted-foreground hover:text-foreground">
                {copied === "pw" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="font-medium text-foreground/80">Puppeteer</p>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 bg-muted/30 rounded px-2 py-1 font-mono truncate text-[11px]">
                puppeteer.connect({'{'} browserWSEndpoint: '{wsUrl}' {'}'})
              </code>
              <button onClick={() => copy(`const browser = await puppeteer.connect({ browserWSEndpoint: '${wsUrl}' });`, "pp")} className="shrink-0 text-muted-foreground hover:text-foreground">
                {copied === "pp" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
