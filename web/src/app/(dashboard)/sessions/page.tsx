"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Plug } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { DataChip } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile, StatTiles } from "@/components/ui/stat-tile";
import { BarChart } from "@/components/ui/bar-chart";
import { Meter } from "@/components/ui/meter";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Button, buttonVariants } from "@/components/ui/button";
import type {
  ParkedSessionsResponse,
  SessionHistoryEntry,
  SessionHistoryResponse,
  SessionsResponse,
} from "@/lib/api";
import { fetchParkedSessions, fetchSessionHistory, fetchSessions } from "@/lib/api";

const REFRESH_MS = 3000;
const PAGE_SIZE = 25;
const HISTORY_LIMIT_MAX = 100;
const ID_HEAD_CHARS = 20;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function formatStamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatCountdown(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "Expiring";
  if (ms < 60000) return `${Math.ceil(ms / 1000)}s left`;
  return `${Math.ceil(ms / 60000)}m left`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function ShortId({ id }: { id: string }) {
  return (
    <span title={id}>
      {id.slice(0, ID_HEAD_CHARS)}
      {id.length > ID_HEAD_CHARS ? <span className="text-line-control">…</span> : null}
    </span>
  );
}

function StateCell({ state, label }: { state: "active" | "closed" | "waiting"; label: string }) {
  const tone = state === "active" ? "text-good" : state === "waiting" ? "text-warn" : "text-fg-soft";
  const dot = state === "active" ? "ui-dot--live bg-good" : state === "waiting" ? "bg-warn" : "bg-fg-3";
  return (
    <span role="cell" className={`flex flex-[0.8_1_90px] items-center gap-[7px] text-[13px] ${tone}`}>
      <span className={`h-[7px] w-[7px] flex-none rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function DurationCell({ ms, maxMs }: { ms: number; maxMs: number }) {
  const pct = maxMs > 0 ? Math.max(4, Math.min(100, (ms / maxMs) * 100)) : 0;
  return (
    <span role="cell" className="flex flex-[1.4_1_150px] items-center gap-2.5">
      <span className="block h-1.5 w-16 flex-none overflow-hidden rounded-[3px] bg-track">
        <span className="block h-full rounded-[3px] bg-brand-text" style={{ width: `${pct}%` }} />
      </span>
      <span className="t-mono text-[12.5px]">{formatDuration(ms)}</span>
    </span>
  );
}

const HEAD_ROW = "t-th flex flex-wrap gap-x-3 gap-y-1 border-b border-line-divider px-3.5 py-3";
const TABLE = "overflow-hidden rounded-card border border-line bg-card px-2 py-1.5 max-[860px]:hidden";

function rowClass(first: boolean): string {
  return `flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-[14px] border-t px-3.5 py-3 text-fg ${first ? "border-transparent" : "border-line-faint"}`;
}

interface MobileRow {
  id: string;
  providerId: string;
  state: "active" | "closed" | "waiting";
  stateLabel: string;
  line: string;
}

function MobileList({ rows }: { rows: MobileRow[] }) {
  return (
    <div className="hidden flex-col gap-2 max-[860px]:flex">
      {rows.map((r) => (
        <div key={r.id} className="ui-card ui-card--plain flex flex-col gap-2 p-4">
          <span className="t-mono truncate text-[13px]" title={r.id}>
            {r.id}
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <DataChip mono>{r.providerId}</DataChip>
            <span
              className={`inline-flex items-center gap-[7px] text-[13px] ${r.state === "active" ? "text-good" : r.state === "waiting" ? "text-warn" : "text-fg-soft"}`}
            >
              <span
                className={`h-[7px] w-[7px] flex-none rounded-full ${r.state === "active" ? "ui-dot--live bg-good" : r.state === "waiting" ? "bg-warn" : "bg-fg-3"}`}
              />
              {r.stateLabel}
            </span>
          </span>
          <span className="text-xs text-fg-2">{r.line}</span>
        </div>
      ))}
    </div>
  );
}

function SectionHead({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h2 className="t-h2">{title}</h2>
      <span className="t-small">{hint}</span>
    </div>
  );
}

export default function SessionsPage() {
  const [live, setLive] = useState<SessionsResponse | null>(null);
  const [parked, setParked] = useState<ParkedSessionsResponse | null>(null);
  const [history, setHistory] = useState<SessionHistoryResponse | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetchSessions();
        if (!cancelled) setLive(r);
      } catch {}
      try {
        const r = await fetchParkedSessions();
        if (!cancelled) setParked(r);
      } catch {}
      try {
        const r = await fetchSessionHistory(limit);
        if (!cancelled) {
          setHistory(r);
          setHistoryFailed(false);
        }
      } catch {
        if (!cancelled) setHistoryFailed(true);
      }
    };
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [limit, reload]);

  const recent = useMemo(() => history?.sessions ?? [], [history]);
  const liveSessions = useMemo(() => live?.sessions ?? [], [live]);
  const parkedSessions = parked?.parked ?? [];
  const activeCount = live?.count ?? 0;
  const finishedTotal = history?.total ?? 0;
  const loading = live === null || (history === null && !historyFailed);

  const stats = useMemo(() => {
    const byProvider = new Map<string, number>();
    for (const s of recent) byProvider.set(s.providerId, (byProvider.get(s.providerId) ?? 0) + 1);
    return {
      medianMs: median(recent.map((s) => s.durationMs)),
      maxMs: Math.max(0, ...recent.map((s) => s.durationMs), ...liveSessions.map((s) => s.durationMs)),
      byProvider: [...byProvider.entries()].sort((a, b) => b[1] - a[1]),
      chart: [...recent].reverse(),
    };
  }, [recent, liveSessions]);

  const neverRan = !loading && activeCount === 0 && parkedSessions.length === 0 && finishedTotal === 0 && !historyFailed;
  const sampleNote = `Last ${recent.length.toLocaleString()} finished`;
  const chartBars = stats.chart;
  const firstBar = chartBars[0];
  const midBar = chartBars[Math.floor(chartBars.length / 2)];
  const lastBar = chartBars[chartBars.length - 1];
  const canLoadMore = recent.length < finishedTotal && limit < HISTORY_LIMIT_MAX && recent.length >= limit;

  return (
    <>
      <PageHeader
        title="Sessions"
        description="Live browser connections routed through the gateway, the ones waiting to reconnect, and the most recent ones that finished."
        actions={
          live ? (
            <span className="t-mono inline-flex h-10 items-center gap-2 rounded-full border border-line bg-card px-3.5 text-xs text-fg-2">
              <span className={`ui-dot ${activeCount > 0 ? "ui-dot--good ui-dot--live" : ""}`} />
              {activeCount} active · {finishedTotal.toLocaleString()} finished
            </span>
          ) : null
        }
      />

      {neverRan ? (
        <EmptyState
          className="ui-card--hero"
          icon={Plug}
          title="No sessions yet"
          hint="Sessions show here as soon as a script or agent connects through the gateway. Each one keeps how long it ran and where it was routed."
          action={
            <>
              <Link href="/" className={buttonVariants({ variant: "primary" })}>
                Connect a client
              </Link>
              <Link href="/playground" className={buttonVariants({ variant: "outline" })}>
                Open Playground
              </Link>
            </>
          }
        />
      ) : (
        <>
          <StatTiles>
            <StatTile
              label="Active now"
              value={activeCount}
              tone={activeCount > 0 ? "good" : undefined}
              note={activeCount > 0 ? "Running right now" : "Nothing is running"}
              loading={live === null}
            />
            <StatTile
              label="Sessions"
              value={finishedTotal.toLocaleString()}
              note="Finished since history started"
              highlight
              loading={loading}
            />
            <StatTile
              label="Median length"
              value={stats.medianMs != null ? formatDuration(stats.medianMs) : "None"}
              note={sampleNote}
              loading={loading}
            />
            <StatTile
              label="Waiting to reconnect"
              value={parkedSessions.length}
              tone={parkedSessions.length > 0 ? "warn" : undefined}
              note="Dropped sessions held open"
              loading={parked === null}
            />
          </StatTiles>

          {chartBars.length > 1 ? (
            <div className="ui-split items-stretch">
              <Card variant="hero" className="flex-[2_1_520px] px-6 py-[22px]">
                <BarChart
                  header={
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <h2 className="t-h2">Last {chartBars.length} sessions</h2>
                      <span className="t-small">Bar height is how long each one ran. Oldest on the left.</span>
                    </div>
                  }
                  ariaLabel={`How long each of the last ${chartBars.length} sessions ran`}
                  max={stats.maxMs}
                  guide={formatDuration(stats.maxMs)}
                  bars={chartBars.map((s) => ({
                    key: s.id,
                    value: s.durationMs,
                    label: `${formatDuration(s.durationMs)}, ${s.providerId}, started ${relativeTime(s.startedAt)}`,
                  }))}
                  format={(bar) => {
                    const s = chartBars.find((x) => x.id === bar.key);
                    return {
                      top: `${formatDuration(bar.value)} · ${s?.providerId ?? ""}`,
                      sub: s ? `Started ${relativeTime(s.startedAt)}` : undefined,
                    };
                  }}
                  axis={
                    firstBar && midBar && lastBar
                      ? [relativeTime(firstBar.startedAt), relativeTime(midBar.startedAt), relativeTime(lastBar.startedAt)]
                      : undefined
                  }
                />
              </Card>

              <section aria-label="Where they ran" className="ui-card flex flex-[1_1_300px] flex-col gap-3 px-[22px] py-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="t-h3">Where they ran</h2>
                  <Link href="/providers" className="t-link text-xs">
                    Providers →
                  </Link>
                </div>
                {stats.byProvider.map(([id, count]) => (
                  <div key={id} className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-semibold">{id}</span>
                      <span className="t-mono text-xs text-fg-2">
                        {count.toLocaleString()} of {recent.length.toLocaleString()}
                      </span>
                    </div>
                    <Meter value={count} max={recent.length} label={`${id} share of sessions`} />
                  </div>
                ))}
                <span className="t-small">
                  {stats.byProvider.length === 1
                    ? "Every session went to one provider. Add a second and the gateway can fail over when it is busy or down."
                    : `${sampleNote}.`}
                </span>
              </section>
            </div>
          ) : null}

          <section aria-label="Live sessions" className="flex flex-col gap-3.5">
            <SectionHead title="Live now" hint="Updates every few seconds." />
            {live === null ? (
              <Card variant="plain" className="rounded-card p-2">
                <SkeletonRows rows={2} />
              </Card>
            ) : liveSessions.length === 0 ? (
              <EmptyState variant="inline" title="No sessions are running." hint="New connections show here." />
            ) : (
              <>
                <div role="table" aria-label="Live sessions" className={TABLE}>
                  <div role="row" className={HEAD_ROW}>
                    <span role="columnheader" className="flex-[1.3_1_130px]">Session</span>
                    <span role="columnheader" className="flex-[1_1_110px]">Provider</span>
                    <span role="columnheader" className="flex-[0.9_1_90px]">Profile</span>
                    <span role="columnheader" className="flex-[0.9_1_90px]">Connected</span>
                    <span role="columnheader" className="flex-[1.4_1_150px]">Running for</span>
                    <span role="columnheader" className="flex-[0.8_1_90px]">State</span>
                    <span role="columnheader" className="flex-[0.8_1_80px] text-right">Messages</span>
                  </div>
                  {liveSessions.map((s, i) => (
                    <div key={s.id} role="row" className={rowClass(i === 0)}>
                      <span role="cell" className="t-mono flex-[1.3_1_130px] text-[13px]">
                        <ShortId id={s.id} />
                      </span>
                      <span role="cell" className="flex flex-[1_1_110px] flex-wrap items-center gap-1.5">
                        <DataChip mono>{s.providerId}</DataChip>
                        {s.proxyName ? (
                          <span className="text-xs text-fg-3" title={`Through proxy ${s.proxyName}`}>
                            via {s.proxyName}
                          </span>
                        ) : null}
                      </span>
                      <span role="cell" className="t-mono flex-[0.9_1_90px] truncate text-[12.5px] text-fg-2">
                        {s.profileId ?? <span className="text-line-control">None</span>}
                      </span>
                      <span role="cell" className="flex-[0.9_1_90px] text-[13px] text-fg-2" title={formatStamp(s.connectedAt)}>
                        {relativeTime(s.connectedAt)}
                      </span>
                      <DurationCell ms={s.durationMs} maxMs={stats.maxMs} />
                      <StateCell state="active" label="Active" />
                      <span role="cell" className="t-mono flex-[0.8_1_80px] text-right text-[12.5px]">
                        {s.messageCount.toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
                <MobileList
                  rows={liveSessions.map((s) => ({
                    id: s.id,
                    providerId: s.providerId,
                    state: "active",
                    stateLabel: "Active",
                    line: `Connected ${relativeTime(s.connectedAt)} · ${formatDuration(s.durationMs)} · ${s.messageCount.toLocaleString()} messages${s.profileId ? ` · profile ${s.profileId}` : ""}`,
                  }))}
                />
              </>
            )}
          </section>

          {parkedSessions.length > 0 ? (
            <section aria-label="Waiting to reconnect" className="flex flex-col gap-3.5">
              <SectionHead
                title="Waiting to reconnect"
                hint="These sessions dropped but are held open so a client can reconnect and pick up where it left off. They are released when the timer runs out."
              />
              <div role="table" aria-label="Sessions waiting to reconnect" className={TABLE}>
                <div role="row" className={HEAD_ROW}>
                  <span role="columnheader" className="flex-[1.3_1_130px]">Session</span>
                  <span role="columnheader" className="flex-[1_1_110px]">Provider</span>
                  <span role="columnheader" className="flex-[0.9_1_90px]">Dropped</span>
                  <span role="columnheader" className="flex-[0.8_1_90px]">State</span>
                  <span role="columnheader" className="flex-[0.8_1_80px]">Messages</span>
                  <span role="columnheader" className="flex-[0.8_1_80px] text-right">Reconnect window</span>
                </div>
                {parkedSessions.map((p, i) => (
                  <div key={p.sessionId} role="row" className={rowClass(i === 0)}>
                    <span role="cell" className="t-mono flex-[1.3_1_130px] text-[13px]">
                      <ShortId id={p.sessionId} />
                    </span>
                    <span role="cell" className="flex-[1_1_110px]">
                      <DataChip mono>{p.providerId}</DataChip>
                    </span>
                    <span role="cell" className="flex-[0.9_1_90px] text-[13px] text-fg-2" title={formatStamp(p.parkedAt)}>
                      {relativeTime(p.parkedAt)}
                    </span>
                    <StateCell state="waiting" label="Waiting" />
                    <span role="cell" className="t-mono flex-[0.8_1_80px] text-[12.5px] text-fg-2">
                      {p.messageCount.toLocaleString()}
                    </span>
                    <span role="cell" className="t-mono flex-[0.8_1_80px] text-right text-[12.5px]">
                      {formatCountdown(p.expiresAt)}
                    </span>
                  </div>
                ))}
              </div>
              <MobileList
                rows={parkedSessions.map((p) => ({
                  id: p.sessionId,
                  providerId: p.providerId,
                  state: "waiting",
                  stateLabel: "Waiting",
                  line: `Dropped ${relativeTime(p.parkedAt)} · ${formatCountdown(p.expiresAt)} · ${p.messageCount.toLocaleString()} messages`,
                }))}
              />
            </section>
          ) : null}

          <section aria-label="Recent sessions" className="flex flex-col gap-3.5">
            <SectionHead title="Recent sessions" hint="Sessions that finished, newest first." />
            {history === null && !historyFailed ? (
              <Card variant="plain" className="rounded-card p-2">
                <SkeletonRows rows={6} />
              </Card>
            ) : historyFailed && recent.length === 0 ? (
              <div className="ui-alert ui-alert--bad items-center">
                <span className="flex-1">The session history did not load. Check that the gateway is running and try again.</span>
                <Button variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}>
                  Retry
                </Button>
              </div>
            ) : recent.length === 0 ? (
              <EmptyState variant="inline" title="No finished sessions yet." hint="Each one shows here when it closes." />
            ) : (
              <>
                <div role="table" aria-label="Recent sessions" className={TABLE}>
                  <div role="row" className={HEAD_ROW}>
                    <span role="columnheader" className="flex-[1.3_1_130px]">Session</span>
                    <span role="columnheader" className="flex-[1_1_110px]">Provider</span>
                    <span role="columnheader" className="flex-[0.9_1_90px]">Started</span>
                    <span role="columnheader" className="flex-[1.4_1_150px]">Ran for</span>
                    <span role="columnheader" className="flex-[0.8_1_90px]">State</span>
                    <span role="columnheader" className="flex-[0.8_1_80px] text-right">Messages</span>
                  </div>
                  {recent.map((s, i) => (
                    <HistoryRow key={`${s.id}-${s.endedAt}`} s={s} maxMs={stats.maxMs} first={i === 0} />
                  ))}
                </div>
                <MobileList
                  rows={recent.map((s) => ({
                    id: s.id,
                    providerId: s.providerId,
                    state: "closed",
                    stateLabel: "Closed",
                    line: `${relativeTime(s.startedAt)} · ${formatDuration(s.durationMs)} · ${s.messageCount.toLocaleString()} messages`,
                  }))}
                />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="t-small">
                    Showing {recent.length.toLocaleString()} of {finishedTotal.toLocaleString()}
                  </span>
                  {canLoadMore ? (
                    <Button variant="outline" onClick={() => setLimit((n) => Math.min(HISTORY_LIMIT_MAX, n + PAGE_SIZE))}>
                      Load {Math.min(PAGE_SIZE, finishedTotal - recent.length, HISTORY_LIMIT_MAX - limit)} more
                    </Button>
                  ) : null}
                </div>
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}

function HistoryRow({ s, maxMs, first }: { s: SessionHistoryEntry; maxMs: number; first: boolean }) {
  return (
    <div role="row" className={rowClass(first)}>
      <span role="cell" className="t-mono flex flex-[1.3_1_130px] flex-col gap-0.5 text-[13px]">
        <ShortId id={s.id} />
        {s.profileId || s.proxyName ? (
          <span className="truncate text-[11px] text-fg-3">
            {[s.profileId ? `profile ${s.profileId}` : null, s.proxyName ? `proxy ${s.proxyName}` : null].filter(Boolean).join(" · ")}
          </span>
        ) : null}
      </span>
      <span role="cell" className="flex-[1_1_110px]">
        <DataChip mono>{s.providerId}</DataChip>
      </span>
      <span role="cell" className="flex-[0.9_1_90px] text-[13px] text-fg-2" title={formatStamp(s.startedAt)}>
        {relativeTime(s.startedAt)}
      </span>
      <DurationCell ms={s.durationMs} maxMs={maxMs} />
      <StateCell state="closed" label="Closed" />
      <span role="cell" className="t-mono flex-[0.8_1_80px] text-right text-[12.5px]">
        {s.messageCount.toLocaleString()}
      </span>
    </div>
  );
}
