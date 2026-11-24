"use client";

import { Globe, Loader2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { RowMenu } from "@/components/ui/row-menu";
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

const ROW_CHIP = "whitespace-nowrap rounded-[10px] border border-line bg-ground px-[9px] py-[3px] text-xs font-semibold text-fg-soft";
const ROW_BUTTON = "h-8 rounded-2xl px-3 text-xs";

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

function scheme(server: string | null): string {
  if (!server) return "?";
  return server.includes("://") ? server.slice(0, server.indexOf("://")).toUpperCase() : "HTTP";
}

function host(server: string): string {
  return server.replace(/^[a-z0-9]+:\/\//i, "");
}

function CheckResult({ kind, result }: { kind: CheckKind; result: ProxyCheckResult }) {
  const source = kind === "browser" ? "A browser through this proxy" : "From this gateway's machine, the proxy";
  if (!result.ok) {
    return <p className="m-0 text-xs text-bad">{kind === "browser" ? "Browser check failed" : "Test failed"}: {result.error}</p>;
  }
  return (
    <div className="ui-well flex flex-col gap-0.5 text-xs text-fg-2">
      <p className="m-0">
        {source} exits at <span className="font-mono text-fg">{result.ip}</span>. Checked in {result.latencyMs} ms.
      </p>
      <p className="m-0 text-fg-3">Location: {location(result)}</p>
      {result.org && <p className="m-0 text-fg-3">Network: {result.org}</p>}
      {result.timezone && <p className="m-0 text-fg-3">Time zone: {result.timezone}</p>}
    </div>
  );
}

function StateBadge({ proxy, check }: { proxy: ProxySummary; check?: { kind: CheckKind; result: ProxyCheckResult } }) {
  if (check) {
    return check.result.ok ? (
      <StatusBadge tone="good">Reached · {check.result.latencyMs} ms</StatusBadge>
    ) : (
      <StatusBadge tone="bad">{check.kind === "browser" ? "Browser check failed" : "Test failed"}</StatusBadge>
    );
  }
  if (!proxy.usable) return <StatusBadge tone="bad">Cannot be used</StatusBadge>;
  return <StatusBadge>Not tested</StatusBadge>;
}

export function ProxyList({ proxies, results, testing, canCheckInBrowser, onTest, onEdit, onDelete }: Props) {
  return (
    <>
      {proxies.map((p) => {
        const result = results[p.name];
        return (
          <article key={p.name} className="flex flex-col gap-3 rounded-[22px] border border-line bg-card px-[18px] py-4">
            <div className="flex flex-wrap items-center gap-x-[18px] gap-y-3">
              <div className="flex min-w-0 flex-[1_1_260px] items-center gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-11 flex-none items-center justify-center rounded-[14px] border border-line bg-ground font-mono text-[13px] font-medium text-fg-soft"
                >
                  {p.name.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase()}
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[15px] font-medium">{p.name}</span>
                    <span className={ROW_CHIP}>{scheme(p.server)}</span>
                  </span>
                  <span className="truncate font-mono text-xs text-fg-3">
                    {p.server ? host(p.server) : "Invalid address"}
                    {p.hasCredentials ? " with saved login" : ""}
                  </span>
                </div>
              </div>
              <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-[3px]">
                <span className="flex">
                  <StateBadge proxy={p} check={result} />
                </span>
                <span className="text-xs text-fg-3">
                  {p.usable ? (
                    <>
                      Use with <span className="font-mono">?proxy={p.name}</span>
                    </>
                  ) : (
                    `Cannot be used: ${p.reason}.`
                  )}
                </span>
              </div>
              <div className="flex min-w-0 flex-[1_1_140px] flex-col gap-px">
                <span className="truncate font-mono text-[13px] font-semibold" title={p.bypass.join(", ")}>
                  {p.bypass.length > 0 ? p.bypass.join(", ") : <span className="font-sans">Nothing</span>}
                </span>
                <span className="text-xs text-fg-3">Skips the proxy</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant="outline"
                  className={ROW_BUTTON}
                  onClick={() => onTest(p.name, "gateway")}
                  disabled={testing !== null}
                  title="Connect through the proxy from this gateway's machine"
                >
                  {testing?.name === p.name && testing.kind === "gateway" ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
                  Test
                </Button>
                <Button
                  variant="outline"
                  className={ROW_BUTTON}
                  onClick={() => onTest(p.name, "browser")}
                  disabled={testing !== null || !p.usable || !canCheckInBrowser}
                  title={canCheckInBrowser ? "Open a browser session through the proxy and see what it reports" : "Needs a provider with Apply proxies on"}
                >
                  {testing?.name === p.name && testing.kind === "browser" ? <Loader2 className="size-3.5 animate-spin" /> : <Globe className="size-3.5" />}
                  Check in a browser
                </Button>
                <Button variant="outline" className={ROW_BUTTON} onClick={() => onEdit(p)}>
                  Edit
                </Button>
                <RowMenu items={[{ label: "Delete proxy", danger: true, onSelect: () => onDelete(p.name) }]} />
              </div>
            </div>
            {result && <CheckResult kind={result.kind} result={result.result} />}
          </article>
        );
      })}
    </>
  );
}
