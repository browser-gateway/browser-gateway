"use client";

import { Globe, Loader2, Pencil, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ProxyCheckResult, ProxySummary } from "@/lib/api";

export type CheckKind = "gateway" | "browser";

interface Props {
  proxies: ProxySummary[];
  results: Record<string, { kind: CheckKind; result: ProxyCheckResult }>;
  testing: { name: string; kind: CheckKind } | null;
  canCheckInBrowser: boolean;
  onTest: (name: string, kind: CheckKind) => void;
  onEdit: (proxy: ProxySummary) => void;
  onDelete: (name: string) => void;
}

function countryName(code: string | null): string {
  if (!code) return "unknown country";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function location(r: ProxyCheckResult & { ok: true }): string {
  const place = [r.city, r.region].filter((v, i, all) => v && all.indexOf(v) === i).join(", ");
  return place ? `${place}, ${countryName(r.country)}` : countryName(r.country);
}

function CheckResult({ kind, result }: { kind: CheckKind; result: ProxyCheckResult }) {
  const source = kind === "browser" ? "A browser through this proxy" : "From this gateway's machine, the proxy";
  if (!result.ok) {
    return <p className="text-xs text-destructive">{kind === "browser" ? "Browser check failed" : "Test failed"}: {result.error}</p>;
  }
  return (
    <div className="text-xs text-foreground space-y-0.5">
      <p>{source} exits at <span className="font-mono">{result.ip}</span>. Checked in {result.latencyMs} ms.</p>
      <p className="text-muted-foreground">Location: {location(result)}</p>
      {result.org && <p className="text-muted-foreground">Network: {result.org}</p>}
      {result.timezone && <p className="text-muted-foreground">Time zone: {result.timezone}</p>}
    </div>
  );
}

function applyLine(p: ProxySummary): string {
  return p.usable ? `Use with ?proxy=${p.name}.` : `Cannot be used: ${p.reason}.`;
}

export function ProxyList({ proxies, results, testing, canCheckInBrowser, onTest, onEdit, onDelete }: Props) {
  return (
    <div className="space-y-3">
      {proxies.map((p) => {
        const result = results[p.name];
        return (
          <Card key={p.name}>
            <CardContent className="px-5 py-4 flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-mono text-foreground">{p.name}</p>
                <p className="text-xs font-mono text-muted-foreground truncate">
                  {p.server ?? "Invalid address"}
                  {p.hasCredentials ? " with saved login" : ""}
                </p>
                {p.bypass.length > 0 && (
                  <p className="text-xs text-muted-foreground">Skips: <span className="font-mono">{p.bypass.join(", ")}</span></p>
                )}
                <p className="text-xs text-muted-foreground">{applyLine(p)}</p>
                {result && <CheckResult kind={result.kind} result={result.result} />}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={() => onTest(p.name, "gateway")} disabled={testing !== null} title="Connect through the proxy from this gateway's machine">
                  {testing?.name === p.name && testing.kind === "gateway" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                  Test
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-xs"
                  onClick={() => onTest(p.name, "browser")}
                  disabled={testing !== null || !p.usable || !canCheckInBrowser}
                  title={canCheckInBrowser ? "Open a browser session through the proxy and see what it reports" : "Needs a provider with Apply proxies on"}
                >
                  {testing?.name === p.name && testing.kind === "browser" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
                  Check in a browser
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => onEdit(p)} title="Edit proxy">
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" onClick={() => onDelete(p.name)} title="Delete proxy">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
