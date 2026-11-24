"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, ChevronDown, Loader2, Plus, Server } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LogoTile } from "@/components/ui/logo-tile";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTile, StatTiles } from "@/components/ui/stat-tile";
import { ProviderCard, ROUTE_COLS } from "@/components/provider-card";
import { ProviderDeleteDialog } from "@/components/provider-delete-dialog";
import { ProviderFormDialog } from "@/components/provider-form";
import {
  fetchStatus,
  fetchProviders,
  deleteProvider,
  testProvider,
  setStrategy,
  updateProvider,
  routableProviders,
  type GatewayStatus,
  type ProviderConfigItem,
  type Strategy,
} from "@/lib/api";
import type { SiblingProvider } from "@shared/provider-form";
import { STRATEGY_OPTIONS } from "@/lib/strategies";

interface TestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

type DialogState = { kind: "add" } | { kind: "edit"; slug: string } | null;

const STRATEGY_SENTENCE: Record<Strategy, string> = {
  "priority-chain": "Every session starts on the provider with the lowest priority number that has room. The next one is used only when it is down or full.",
  "round-robin": "Take turns across every ready provider. If one is down or full, the session starts on the next one.",
  "least-connections": "Each session goes to the provider with the fewest sessions open right now.",
  "latency-optimized": "Each session goes to the provider that has been connecting fastest lately.",
  weighted: "Sessions are split in proportion to each provider's weight.",
};

const HERO_GLOW: React.CSSProperties = {
  backgroundImage: "var(--dots), radial-gradient(560px 300px at 0% 0%, color-mix(in srgb, var(--brand) 26%, transparent), transparent 70%)",
  backgroundSize: "18px 18px, auto",
};

function plannedSplit(strategy: string, enabled: ProviderConfigItem[]): Record<string, number> | null {
  if (enabled.length === 0) return null;
  if (strategy === "round-robin") {
    const each = Math.round(100 / enabled.length);
    return Object.fromEntries(enabled.map((p) => [p.id, each]));
  }
  if (strategy === "weighted") {
    const sum = enabled.reduce((n, p) => n + (p.weight ?? 0), 0);
    if (sum <= 0) return null;
    return Object.fromEntries(enabled.map((p) => [p.id, Math.round(((p.weight ?? 0) / sum) * 100)]));
  }
  return null;
}

function dialogFromUrl(pathname: string, slug: string | null): DialogState {
  if (/\/providers\/new\/?$/.test(pathname)) return { kind: "add" };
  if (/\/providers\/edit\/?$/.test(pathname) && slug) return { kind: "edit", slug };
  return null;
}

function ProvidersContent() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const urlSlug = search.get("slug") ?? search.get("id");

  const [status, setStatus] = React.useState<GatewayStatus | null>(null);
  const [providers, setProviders] = React.useState<ProviderConfigItem[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState(false);
  const [testResults, setTestResults] = React.useState<Record<string, TestResult>>({});
  const [testingId, setTestingId] = React.useState<string | null>(null);
  const [testingAll, setTestingAll] = React.useState(false);
  const [togglingId, setTogglingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [savingStrategy, setSavingStrategy] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<DialogState>(() => dialogFromUrl(pathname, urlSlug));

  const refresh = React.useCallback(async () => {
    try {
      const [s, p] = await Promise.all([fetchStatus(), fetchProviders()]);
      setStatus(s);
      setProviders(p.providers);
      setError(null);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  React.useEffect(() => {
    queueMicrotask(() => void refresh());
    const interval = setInterval(refresh, 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const siblings: SiblingProvider[] = React.useMemo(
    () =>
      routableProviders(providers).map((p) => ({
        slug: p.id,
        priority: p.priority,
        weight: p.weight,
      })),
    [providers],
  );

  const statusMap = React.useMemo(
    () =>
      status
        ? Object.fromEntries(status.providers.map((p) => [p.id, p]))
        : ({} as Record<string, GatewayStatus["providers"][number]>),
    [status],
  );

  function closeDialog() {
    setDialog(null);
    if (!/\/providers\/?$/.test(pathname)) router.replace("/providers");
  }

  async function handleStrategyChange(next: Strategy) {
    setSavingStrategy(true);
    const res = await setStrategy(next);
    setSavingStrategy(false);
    if (res.ok) await refresh();
    else setError(res.error ?? "Could not change routing strategy");
  }

  async function handleToggleEnabled(id: string, enabled: boolean) {
    setTogglingId(id);
    const res = await updateProvider(id, { enabled }).catch(() => ({ ok: false, error: "Request failed" }));
    setTogglingId(null);
    if (!res.ok) setError(res.error ?? "Could not change the provider");
    await refresh();
  }

  async function runOne(id: string) {
    try {
      const result = await testProvider(id);
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: false, latencyMs: 0, error: "Failed" },
      }));
    }
  }

  async function handleTest(id: string) {
    setTestingId(id);
    await runOne(id);
    setTestingId(null);
  }

  async function handleTestAll() {
    const targets = routableProviders(providers);
    if (targets.length === 0) return;
    setTestingAll(true);
    setTestResults((prev) => {
      const next = { ...prev };
      for (const p of targets) delete next[p.id];
      return next;
    });
    await Promise.all(targets.map((p) => runOne(p.id)));
    setTestingAll(false);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const result = await deleteProvider(deleteTarget);
    if (result.ok) {
      setDeleteTarget(null);
      await refresh();
    } else {
      setError(result.error ?? "Failed to delete");
    }
  }

  const ordered = React.useMemo(
    () => providers.map((p, i) => ({ p, i })).sort((a, b) => a.p.priority - b.p.priority || a.i - b.i).map(({ p }) => p),
    [providers],
  );
  const enabled = ordered.filter((p) => p.enabled !== false);
  const strategy = (status?.strategy ?? "priority-chain") as Strategy;
  const split = plannedSplit(strategy, enabled);
  const readyCount = enabled.filter((p) => {
    const s = statusMap[p.id];
    return s && s.healthy !== false && !s.cooldownUntil;
  }).length;
  const totalSent = status ? status.providers.reduce((n, p) => n + p.totalConnections, 0) : 0;

  const addButton = (
    <Button variant="accent" onClick={() => setDialog({ kind: "add" })}>
      <Plus strokeWidth={2.4} />
      Add provider
    </Button>
  );

  const dialogs = (
    <>
      {dialog ? (
        <ProviderFormDialog
          slug={dialog.kind === "edit" ? dialog.slug : null}
          onClose={closeDialog}
          onSaved={() => {
            closeDialog();
            void refresh();
          }}
        />
      ) : null}
      <ProviderDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        providerId={deleteTarget}
        onConfirm={confirmDelete}
      />
    </>
  );

  const header = (
    <PageHeader
      title="Providers"
      description="Remote browser services the gateway routes connections to."
      actions={providers.length > 0 ? addButton : undefined}
    />
  );

  if (!loaded) {
    return (
      <>
        {header}
        <div className="ui-split">
          <Skeleton className="h-[280px] flex-[3_1_560px] rounded-hero" />
          <Skeleton className="h-[280px] flex-[2_1_340px] rounded-card" />
        </div>
        <Skeleton className="h-[260px] rounded-card" />
        {dialogs}
      </>
    );
  }

  return (
    <>
      {header}

      {loadError ? (
        <Alert title="The provider list did not load">
          Check that the gateway is running, then{" "}
          <button type="button" className="t-link" onClick={() => void refresh()}>
            retry
          </button>
          .
        </Alert>
      ) : null}

      {error ? <Alert title="That change was not saved">{error}</Alert> : null}

      {providers.length === 0 ? (
        loadError ? null : (
          <EmptyState
            icon={Server}
            title="No providers yet"
            hint="Connect a self-hosted Playwright server, a cloud browser service, or a local Chrome with remote debugging on. Providers you add show here."
            action={
              <Button variant="primary" onClick={() => setDialog({ kind: "add" })}>
                Add provider
              </Button>
            }
          />
        )
      ) : (
        <>
          <div className="flex flex-wrap gap-5">
            <section
              aria-label="How sessions are routed"
              className="box-border flex min-w-0 flex-[2_1_520px] flex-col gap-[18px] rounded-[28px] border border-line bg-card p-6"
              style={HERO_GLOW}
            >
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
                <div className="flex flex-col gap-0.5">
                  <h2 className="m-0 text-2xl font-bold tracking-[-0.02em]">How this gateway routes</h2>
                  <span className="text-[13px] text-fg-3">
                    {STRATEGY_OPTIONS.find((o) => o.value === strategy)?.hint ??
                      "How the gateway picks which provider handles each session."}
                  </span>
                </div>
                {status ? (
                  <Select
                    label="Strategy"
                    value={strategy}
                    options={STRATEGY_OPTIONS}
                    onChange={(v) => void handleStrategyChange(v)}
                    disabled={savingStrategy}
                    align="right"
                    triggerClassName="h-[46px] gap-2.5 rounded-[23px] bg-raised pl-[18px] pr-2 text-sm [&_.label]:text-fg-2 [&_.value]:font-bold"
                    chevron={
                      <span
                        className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full text-white"
                        style={{ backgroundColor: "var(--brand)", backgroundImage: "var(--brand-grad)" }}
                      >
                        {savingStrategy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" strokeWidth={2.4} />}
                      </span>
                    }
                  />
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="flex h-12 items-center rounded-3xl bg-raised px-4 text-sm font-semibold">Any agent or CDP client</span>
                <ArrowRight className="h-[18px] w-[18px] flex-none text-fg-3" strokeWidth={2} />
                <span
                  className="flex h-12 items-center rounded-3xl px-[18px] text-sm font-bold text-white"
                  style={{ backgroundColor: "var(--brand)", backgroundImage: "var(--brand-grad)" }}
                >
                  {STRATEGY_OPTIONS.find((o) => o.value === strategy)?.label ?? strategy}
                </span>
                <ArrowRight className="h-[18px] w-[18px] flex-none text-fg-3" strokeWidth={2} />
                {enabled.length === 0 ? (
                  <span className="flex h-12 items-center rounded-3xl border border-dashed border-line-strong px-4 text-sm text-fg-3">
                    No provider is on
                  </span>
                ) : (
                  enabled.map((p) => (
                    <span key={p.id} className="flex h-12 min-w-0 max-w-full items-center gap-2.5 rounded-3xl bg-raised pl-1.5 pr-3.5">
                      <LogoTile name={p.id} size={36} className="!rounded-full shadow-none" />
                      <span className="truncate font-mono text-[13px]">{p.id}</span>
                      {split ? <span className="text-sm font-bold text-brand-text">{split[p.id]}%</span> : null}
                    </span>
                  ))
                )}
              </div>
              <p className="m-0 max-w-[640px] text-sm text-fg-2">{STRATEGY_SENTENCE[strategy] ?? ""}</p>
            </section>

            <StatTiles className="min-w-0 flex-[1_1_300px] grid-cols-2 content-start">
              <StatTile label="Sessions open" value={status ? status.activeSessions : "—"} note="across all providers" highlight />
              <StatTile
                label="Ready now"
                value={`${readyCount} of ${providers.length}`}
                note={readyCount === 1 ? "provider taking traffic" : "providers taking traffic"}
              />
              <StatTile label="Waiting" value={status ? status.queueSize : "—"} note="sessions queued for room" />
              <StatTile label="Sessions sent" value={totalSent.toLocaleString()} note="since the gateway started" />
            </StatTiles>
          </div>

          <section aria-label="Route order" className="rounded-[28px] border border-line bg-card">
            <div className="px-5 pb-2.5 pt-[22px] max-[860px]:px-4">
              <div className="flex flex-wrap items-center justify-between gap-3 px-1 pb-3.5">
                <div className="flex flex-col gap-0.5">
                  <h2 className="m-0 text-xl font-bold tracking-[-0.02em]">Route order</h2>
                  <span className="text-[13px] text-fg-3">Lower priority goes first, and weight sets the split between equals.</span>
                </div>
                <button
                  type="button"
                  onClick={() => void handleTestAll()}
                  disabled={testingAll || enabled.length === 0}
                  className="flex h-[38px] items-center gap-2 rounded-[19px] border border-line-strong bg-transparent px-4 text-[13px] font-semibold text-fg hover:bg-raised disabled:opacity-60"
                >
                  {testingAll ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Test all providers
                </button>
              </div>
              <div className={`${ROUTE_COLS} hidden h-9 px-1 text-xs font-semibold text-fg-3`}>
                <span />
                <span>Provider</span>
                <span>Status</span>
                <span>Priority · weight</span>
                <span>In use</span>
                <span className="text-right">Connect</span>
                <span className="text-right">On</span>
                <span />
              </div>
              {ordered.map((provider) => (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  status={statusMap[provider.id]}
                  siblings={siblings}
                  testResult={testResults[provider.id]}
                  testing={testingId === provider.id || (testingAll && provider.enabled !== false && !testResults[provider.id])}
                  onTest={() => void handleTest(provider.id)}
                  toggling={togglingId === provider.id}
                  onToggleEnabled={(next) => void handleToggleEnabled(provider.id, next)}
                  onEdit={() => setDialog({ kind: "edit", slug: provider.id })}
                  onDelete={() => setDeleteTarget(provider.id)}
                />
              ))}
            </div>
          </section>
        </>
      )}

      {dialogs}
    </>
  );
}

export default function ProvidersPage() {
  return (
    <React.Suspense fallback={null}>
      <ProvidersContent />
    </React.Suspense>
  );
}
