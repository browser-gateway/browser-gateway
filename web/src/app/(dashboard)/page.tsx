"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Play, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { SparkBars } from "@/components/ui/bar-chart";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectAgentCard, PROMPT_COPIED_EVENT, PROMPT_COPIED_KEY } from "@/components/connect-agent-card";
import { cn } from "@/lib/utils";
import { formatDuration, formatStamp, plural, relativeTime } from "@/lib/format";
import { STRATEGY_OPTIONS } from "@/lib/strategies";
import {
  AuthError,
  fetchProfiles,
  fetchSessionHistory,
  fetchSettings,
  fetchStatus,
  type GatewayStatus,
  type SessionDefaults,
  type SessionHistoryEntry,
  type SessionHistoryResponse,
} from "@/lib/api";

const LIVE_REFRESH_MS = 5_000;
const RECENT_COUNT = 5;
const SPARK_DAYS = 10;
const SETUP_SKIPPED_KEY = "bg.overview.setup-skipped";
const HEADER_BTN = "h-[42px] text-sm";

interface SetupStep {
  key: string;
  done: boolean;
  title: string;
  note: string;
  action?: { label: string; href: string; primary?: boolean };
}

function useStoredFlag(key: string, event?: string): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(false);
  useEffect(() => {
    const read = () => {
      try {
        setValue(window.localStorage.getItem(key) === "1");
      } catch {
        setValue(false);
      }
    };
    read();
    if (!event) return;
    window.addEventListener(event, read);
    return () => window.removeEventListener(event, read);
  }, [key, event]);
  const set = (v: boolean) => {
    setValue(v);
    try {
      if (v) window.localStorage.setItem(key, "1");
      else window.localStorage.removeItem(key);
    } catch {
      return;
    }
  };
  return [value, set];
}

export default function OverviewPage() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [history, setHistory] = useState<SessionHistoryResponse | null>(null);
  const [profilesOn, setProfilesOn] = useState<boolean | null>(null);
  const [defaults, setDefaults] = useState<SessionDefaults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useStoredFlag(SETUP_SKIPPED_KEY);
  const [promptCopied] = useStoredFlag(PROMPT_COPIED_KEY, PROMPT_COPIED_EVENT);
  const [showSetupAgain, setShowSetupAgain] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [s, h] = await Promise.all([fetchStatus(), fetchSessionHistory(RECENT_COUNT)]);
        if (cancelled) return;
        setStatus(s);
        setHistory(h);
        setError(null);
      } catch (err) {
        if (err instanceof AuthError) {
          window.location.reload();
          return;
        }
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const t = setInterval(load, LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    fetchProfiles().then((p) => setProfilesOn(p.enabled), () => setProfilesOn(false));
    fetchSettings().then((s) => setDefaults(s.sessionDefaults), () => setDefaults(null));
  }, []);

  const ranAny = (history?.total ?? 0) > 0 || (status?.activeSessions ?? 0) > 0;

  const steps = useMemo<SetupStep[] | null>(() => {
    if (!status || !history || profilesOn === null) return null;
    const providerDone = status.providers.length > 0;
    return [
      {
        key: "provider",
        done: providerDone,
        title: "Add a browser provider",
        note: providerDone
          ? `${plural(status.providers.length, "provider")} connected.`
          : "Connect a cloud browser service, your own Chrome, or any CDP endpoint.",
        action: { label: "Add provider", href: "/providers/new/", primary: true },
      },
      {
        key: "session",
        done: ranAny,
        title: "Run your first session",
        note: ranAny ? "Sessions are reaching this gateway." : "Open a browser from the Playground, or connect your own code.",
        action: { label: "Open Playground", href: "/playground/", primary: true },
      },
      {
        key: "agent",
        done: promptCopied,
        title: "Connect an AI agent",
        note: promptCopied
          ? "Prompt copied. Ask your agent to open a page to check the connection."
          : "Copy the prompt from the Connect card into Claude Code, Codex, Cursor or another agent.",
        action: { label: "Go to Connect", href: "#connect" },
      },
      {
        key: "profiles",
        done: profilesOn,
        title: "Turn on profiles",
        note: profilesOn
          ? "Logins and cookies can be saved between sessions."
          : "Save logins and cookies so the next session starts signed in.",
        action: { label: "Open Profiles", href: "/profiles/" },
      },
    ];
  }, [status, history, profilesOn, ranAny, promptCopied]);

  const doneCount = steps?.filter((s) => s.done).length ?? 0;
  const leftCount = steps ? steps.length - doneCount : 0;
  const setupVisible = steps !== null && leftCount > 0 && (!skipped || showSetupAgain);

  const description =
    steps === null
      ? "Gateway status, sessions and providers."
      : leftCount > 0 && !setupVisible
        ? "Setup is paused. Here is how the gateway is doing."
        : leftCount > 0
          ? `${plural(leftCount, "step")} left to get the most out of the gateway.`
          : "Everything is set up. Here is how the gateway is doing.";

  return (
    <>
      <PageHeader
        title="Overview"
        description={description}
        actions={
          <>
            {steps && leftCount > 0 && skipped && !showSetupAgain ? (
              <Button
                variant="outline"
                className={cn(HEADER_BTN, "border-brand-text bg-brand-soft px-[18px] font-bold hover:bg-brand-soft")}
                onClick={() => setShowSetupAgain(true)}
              >
                Finish setup
                <span className="font-mono text-xs font-medium text-fg-2">{leftCount} left</span>
              </Button>
            ) : null}
            <Link href="/playground/" className={cn(buttonVariants({ variant: "outline" }), HEADER_BTN, "px-[18px]")}>
              <Play strokeWidth={2} />
              Playground
            </Link>
            <Link href="/providers/new/" className={cn(buttonVariants({ variant: "accent" }), HEADER_BTN, "px-5")}>
              <Plus strokeWidth={2.4} />
              Add provider
            </Link>
          </>
        }
      />

      {error ? (
        <Alert title="The gateway API did not answer">{error} The numbers below may be out of date.</Alert>
      ) : null}

      {status?.status === "shutting_down" ? (
        <Alert variant="warn" title="Gateway is shutting down">
          Active sessions are draining. New connections are refused.
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-stretch gap-5">
        <div className="flex min-w-0 flex-[3_1_560px] flex-col">
          {setupVisible && steps ? (
            <SetupCard
              steps={steps}
              done={doneCount}
              onSkip={() => {
                setShowSetupAgain(false);
                setSkipped(true);
              }}
            />
          ) : (
            <ActivityCard history={history} running={status?.activeSessions ?? 0} queued={status?.queueSize ?? 0} />
          )}
        </div>
        <div id="connect" className="flex min-w-0 flex-[2_1_380px] scroll-mt-20 flex-col">
          <ConnectAgentCard agentConnected={ranAny} />
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-5">
        <SessionsCard history={history} running={status?.activeSessions ?? null} />
        <ProvidersCard status={status} />
        <RoutingCard status={status} defaults={defaults} />
      </div>

      <RecentSessionsCard history={history} />
    </>
  );
}

function SetupCard({ steps, done, onSkip }: { steps: SetupStep[]; done: number; onSkip: () => void }) {
  const label = `${done} of ${steps.length} done.`;
  return (
    <section aria-label="Setup" className="ui-card ui-card--hero flex flex-1 flex-col gap-[18px] p-7 max-[860px]:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="rounded-[13px] bg-brand-soft px-3 py-[5px] text-xs font-bold text-brand-text">Get set up</span>
        <Button variant="outline" className="h-9 px-4" onClick={onSkip}>
          Skip setup
        </Button>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <h2 className="m-0 text-[32px] font-bold leading-[1.08] tracking-[-0.035em]">{label}</h2>
        <div role="img" aria-label={label} className="mb-2 flex h-2.5 max-w-[320px] flex-[1_1_220px] gap-1">
          {steps.map((s) => (
            <span key={s.key} className={cn("flex-1 rounded-[5px]", s.done ? "bg-brand-text" : "bg-line")} />
          ))}
        </div>
      </div>
      <div className="flex flex-col">
        {steps.map((s, i) => (
          <div key={s.key} className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line-divider py-4">
            <span
              aria-hidden="true"
              className={cn(
                "t-mono flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full border text-[13px] font-medium",
                s.done ? "border-good-bg bg-good-bg text-good" : "border-line-strong text-fg-2",
              )}
            >
              {s.done ? "✓" : i + 1}
            </span>
            <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5">
              <span className={cn("text-base font-bold tracking-[-0.01em]", s.done && "text-fg-2")}>{s.title}</span>
              <span className="text-[13px] text-fg-2 [text-wrap:pretty]">{s.note}</span>
            </div>
            {s.done ? (
              <StatusBadge tone="good" className="before:hidden">
                Done
              </StatusBadge>
            ) : s.action ? (
              <Link
                href={s.action.href}
                className={cn(buttonVariants({ variant: s.action.primary ? "primary" : "outline" }), "h-[38px] px-4 font-bold")}
              >
                {s.action.label}
              </Link>
            ) : null}
          </div>
        ))}
      </div>
      <p className="t-small">Skipping hides this checklist. You can bring it back from the top of the page until every step is done.</p>
    </section>
  );
}

type Range = "7" | "30" | "90";

const RANGES: Array<{ value: Range; label: string }> = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

const CHART_HEIGHT = 150;

function shortDay(key: string, withMonth: boolean): string {
  const d = new Date(`${key}T00:00:00Z`);
  return withMonth ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : String(d.getUTCDate());
}

function ActivityCard({ history, running, queued }: { history: SessionHistoryResponse | null; running: number; queued: number }) {
  const [range, setRange] = useState<Range>("30");
  const days = (history?.days ?? []).slice(-Number(range)).map((d) => ({ key: d.date, value: d.count }));
  const total = days.reduce((n, d) => n + d.value, 0);
  const max = Math.max(1, ...days.map((d) => d.value));
  const peakIndex = days.reduce((best, d, i) => (d.value > days[best].value ? i : best), 0);
  const dense = days.length > 14;
  const gap = days.length > 45 ? 2 : dense ? 4 : 10;
  const labelEvery = days.length > 45 ? 15 : dense ? 5 : 1;
  const first = days[0]?.key;
  const last = days[days.length - 1]?.key;
  const peak = days[peakIndex];
  const summary = total === 0 || !peak ? "No sessions in this range." : `Sessions per day. Peak of ${peak.value} on ${shortDay(peak.key, true)}.`;
  const lastAt = history?.sessions[0]?.endedAt ?? null;

  return (
    <section aria-label="Activity" className="ui-card ui-card--hero flex flex-[1_1_auto] flex-col gap-[18px] rounded-[28px] p-7 max-[860px]:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="rounded-[13px] bg-brand-soft px-3 py-[5px] text-xs font-bold text-brand-text">Activity</span>
        <div role="group" aria-label="Time range" className="flex gap-1 rounded-[20px] border border-line bg-ground p-1">
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              aria-pressed={range === r.value}
              onClick={() => setRange(r.value)}
              className={cn(
                "h-[30px] rounded-[15px] border-0 px-3 text-xs",
                range === r.value ? "bg-fg font-bold text-ground" : "bg-transparent font-semibold text-fg-2 hover:text-fg",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {history === null ? (
        <>
          <span className="ui-skeleton block h-9 w-[60%] rounded-xl" />
          <span className="ui-skeleton block min-h-[190px] flex-[1_1_auto] rounded-2xl" />
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <h2 className="m-0 text-[32px] font-bold leading-[1.08] tracking-[-0.035em]">
              {plural(total, "session")} in {range} days.
            </h2>
            <span className="text-sm text-fg-2">
              Finished sessions per day (UTC), {first ? shortDay(first, true) : ""} to {last ? shortDay(last, true) : ""}.
            </span>
          </div>
          <div role="img" aria-label={summary} className="flex min-h-[190px] flex-[1_1_auto] items-end border-b border-line" style={{ gap }}>
            {days.map((d, i) => {
              const h = d.value === 0 ? 2 : Math.max(3, Math.round((d.value / max) * CHART_HEIGHT));
              const showValue = d.value > 0 && (dense ? i === peakIndex : d.value >= max * 0.2);
              return (
                <div key={d.key} className="flex min-w-0 flex-[1_1_0] flex-col items-center justify-end gap-1.5" title={`${shortDay(d.key, true)}: ${d.value}`}>
                  <span className="font-mono text-xs text-fg">{showValue ? d.value : ""}</span>
                  <span
                    className={cn("block w-full max-w-10 rounded-t", d.value === 0 ? "bg-line-strong" : i === peakIndex ? "bg-brand" : "bg-brand-text")}
                    style={{ height: h }}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex text-xs text-fg-3" style={{ gap }}>
            {days.map((d, i) => {
              const edge = i === 0 || i === days.length - 1;
              const show = edge || (i % labelEvery === 0 && i < days.length - Math.ceil(labelEvery / 2));
              return (
                <span
                  key={d.key}
                  className={cn(
                    "min-w-0 flex-[1_1_0] whitespace-nowrap",
                    dense && i === 0 ? "text-left" : dense && i === days.length - 1 ? "flex justify-end" : "text-center",
                    dense && "overflow-visible",
                  )}
                >
                  {show ? shortDay(d.key, edge) : ""}
                </span>
              );
            })}
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))] gap-3">
            <Stat label="Running now" value={running.toLocaleString()} note={queued > 0 ? `${queued} waiting` : undefined} />
            <Stat label="Last session" value={lastAt ? relativeTime(lastAt) : "None yet"} />
            <Stat label="All time" value={history.total.toLocaleString()} />
          </div>
        </>
      )}
    </section>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-2xl bg-raised px-4 py-3.5">
      <span className="text-xs text-fg-2">{label}</span>
      <span className="text-[22px] font-bold tracking-[-0.03em]">
        {value}
        {note ? <span className="ml-2 text-xs font-medium tracking-normal text-warn">{note}</span> : null}
      </span>
    </div>
  );
}

type Glow = "brand" | "good" | "warn";

const GLOW: Record<Glow, { hue: string; text: string }> = {
  brand: { hue: "var(--brand)", text: "text-brand-text" },
  good: { hue: "#2fbf7f", text: "text-[#7fe3ae]" },
  warn: { hue: "#e0a030", text: "text-warn" },
};

const QUIET_LINK = "text-[13px] font-semibold text-fg-2 hover:text-fg";
const BIG = "text-[44px] font-bold leading-none tracking-[-0.05em]";

function SummaryCard({
  label,
  glow,
  eyebrow,
  action,
  children,
}: {
  label: string;
  glow: Glow;
  eyebrow: string;
  action: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="ui-card flex min-w-0 flex-col gap-3 p-5"
      style={{
        backgroundImage: `var(--dots), radial-gradient(320px 200px at 100% 0%, color-mix(in srgb, ${GLOW[glow].hue} 24%, transparent), transparent 70%)`,
        backgroundSize: "var(--dot-size), auto",
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className={cn("text-xs font-bold", GLOW[glow].text)}>{eyebrow}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

function SessionsCard({ history, running }: { history: SessionHistoryResponse | null; running: number | null }) {
  const lastDays = history ? history.days.slice(-30) : [];
  const monthTotal = lastDays.reduce((n, d) => n + d.count, 0);
  const spark = lastDays.slice(-SPARK_DAYS).map((d) => d.count);
  const last = history?.sessions[0];
  return (
    <SummaryCard
      label="Sessions"
      glow="brand"
      eyebrow="Sessions, last 30 days"
      action={
        <Link href="/sessions/" className={QUIET_LINK}>
          View all
        </Link>
      }
    >
      {history && running !== null ? (
        <>
          <div className="flex items-end justify-between gap-4">
            <span className={BIG}>{monthTotal.toLocaleString()}</span>
            {spark.some((n) => n > 0) ? <SparkBars values={spark} className="flex-[0_1_160px]" /> : null}
          </div>
          <span className="text-[13px] text-fg-2">
            {running > 0 ? `${running.toLocaleString()} running now.` : "None running."}{" "}
            {last ? `Last one ended ${relativeTime(last.endedAt)}.` : "No sessions yet."}
          </span>
        </>
      ) : (
        <Skeleton className="h-[68px]" />
      )}
    </SummaryCard>
  );
}

function ProvidersCard({ status }: { status: GatewayStatus | null }) {
  const total = status?.providers.length ?? 0;
  const healthy = status?.providers.filter((p) => p.healthy).length ?? 0;
  const cooling = status?.providers.filter((p) => p.cooldownUntil).length ?? 0;
  return (
    <SummaryCard
      label="Providers"
      glow="good"
      eyebrow="Provider health"
      action={
        <Link href="/providers/" className={QUIET_LINK}>
          Manage
        </Link>
      }
    >
      {status ? (
        <>
          <span className={BIG}>
            {healthy}
            <span className="text-2xl font-semibold tracking-normal text-fg-3">/{total}</span>
          </span>
          <span className="text-[13px] text-fg-2">
            {total === 0
              ? "No provider yet. Add one to start sessions."
              : healthy === total
                ? total === 1
                  ? "The only provider is healthy."
                  : "All providers are healthy."
                : `${plural(total - healthy, "provider")} not healthy${cooling > 0 ? `, ${cooling} cooling down` : ""}.`}
          </span>
        </>
      ) : (
        <Skeleton className="h-[68px]" />
      )}
    </SummaryCard>
  );
}

function describeDefaults(d: SessionDefaults): string {
  const parts = [
    d.record ? "recording on" : "recording off",
    d.profile ? `profile ${d.profile}` : "no default profile",
    d.proxy ? `proxy ${d.proxy}` : "no default proxy",
  ];
  const text = parts.join(", ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function RoutingCard({ status, defaults }: { status: GatewayStatus | null; defaults: SessionDefaults | null }) {
  const label = STRATEGY_OPTIONS.find((o) => o.value === status?.strategy)?.label ?? status?.strategy;
  const providers = [...(status?.providers ?? [])].sort((a, b) => a.priority - b.priority);
  return (
    <SummaryCard
      label="Routing"
      glow="warn"
      eyebrow="Routing"
      action={
        <Link href="/settings/" className={QUIET_LINK}>
          Change
        </Link>
      }
    >
      {status ? (
        <>
          <span className="t-h1">{label}</span>
          <div className="flex flex-wrap items-center gap-2">
            {providers.slice(0, 3).map((p) => (
              <span key={p.id} className="t-mono flex h-8 items-center gap-2 rounded-full bg-raised px-3 text-[13px]">
                <span className={cn("ui-dot", p.healthy ? "ui-dot--good" : "ui-dot--bad")} />
                {p.id}
              </span>
            ))}
            {providers.length > 3 ? <span className="text-[13px] text-fg-2">and {providers.length - 3} more</span> : null}
          </div>
          {defaults ? <span className="text-[13px] text-fg-2">{describeDefaults(defaults)}</span> : null}
        </>
      ) : (
        <Skeleton className="h-[68px]" />
      )}
    </SummaryCard>
  );
}

const COLS = "grid grid-cols-[minmax(140px,1.4fr)_130px_110px_100px_90px] items-center gap-x-3";

function RecentSessionsCard({ history }: { history: SessionHistoryResponse | null }) {
  const sessions: SessionHistoryEntry[] = history?.sessions ?? [];
  return (
    <section aria-label="Recent sessions" className="ui-card ui-card--plain overflow-x-auto rounded-hero">
      <div className="min-w-[600px] px-6 pb-2.5 pt-[22px]">
        <div className="flex items-center justify-between gap-3 pb-3">
          <h2 className="t-h2 leading-[1.4]">Recent sessions</h2>
          {sessions.length > 0 ? (
            <Link href="/sessions/" className="t-link">
              All sessions →
            </Link>
          ) : null}
        </div>
        {history === null ? (
          <div className="flex flex-col gap-2 pb-4">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="pb-8 pt-5 text-center text-sm text-fg-2">
            No sessions yet. They show here as soon as a script or agent connects.
          </div>
        ) : (
          <>
            <div className={`${COLS} h-[34px] text-xs font-semibold text-fg-3`}>
              <span>Session</span>
              <span>Provider</span>
              <span>Ended</span>
              <span>Duration</span>
              <span>Messages</span>
            </div>
            {sessions.map((s) => (
              <div key={s.id} className={`${COLS} border-t border-line-divider py-3`}>
                <span className="t-mono min-w-0 truncate text-[13px]" title={s.id}>
                  {s.id}
                </span>
                <span className="t-mono justify-self-start truncate rounded-chip bg-raised px-2.5 py-[3px] text-xs">{s.providerId}</span>
                <span className="text-[13px] text-fg-2" title={formatStamp(s.endedAt)}>
                  {relativeTime(s.endedAt)}
                </span>
                <span className="t-mono text-[13px]">{formatDuration(s.durationMs)}</span>
                <span className="t-mono text-[13px] text-fg-2">{s.messageCount.toLocaleString()}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}
