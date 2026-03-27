"use client";

import { useEffect, useState } from "react";
import { Server } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

      <div className="grid gap-4 sm:grid-cols-3">
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
