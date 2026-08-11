"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, Server } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, type SelectOption } from "@/components/ui/select";
import { ProviderCard } from "@/components/provider-card";
import { ProviderDeleteDialog } from "@/components/provider-delete-dialog";
import {
  fetchStatus,
  fetchProviders,
  deleteProvider,
  testProvider,
  setStrategy,
  type GatewayStatus,
  type ProviderConfigItem,
  type Strategy,
} from "@/lib/api";
import type { SiblingProvider } from "@shared/provider-form";

const STRATEGY_OPTIONS: SelectOption<Strategy>[] = [
  { value: "priority-chain", label: "Priority chain", hint: "Always use the highest-priority provider that has room." },
  { value: "round-robin", label: "Round robin", hint: "Spread sessions evenly across providers." },
  { value: "least-connections", label: "Least busy", hint: "Send to whichever provider has the fewest active sessions." },
  { value: "latency-optimized", label: "Fastest", hint: "Prefer the provider with the lowest recent latency." },
  { value: "weighted", label: "Weighted", hint: "Split traffic by each provider's weight." },
];

interface TestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export default function ProvidersPage() {
  const [status, setStatus] = React.useState<GatewayStatus | null>(null);
  const [providers, setProviders] = React.useState<ProviderConfigItem[]>([]);
  const [testResults, setTestResults] = React.useState<Record<string, TestResult>>({});
  const [testingId, setTestingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [savingStrategy, setSavingStrategy] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const [s, p] = await Promise.all([fetchStatus(), fetchProviders()]);
      setStatus(s);
      setProviders(p.providers);
      setError(null);
    } catch {}
  }, []);

  React.useEffect(() => {
    void refresh();
    const interval = setInterval(refresh, 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const siblings: SiblingProvider[] = React.useMemo(
    () =>
      providers.map((p) => ({
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

  async function handleStrategyChange(next: Strategy) {
    setSavingStrategy(true);
    const res = await setStrategy(next);
    setSavingStrategy(false);
    if (res.ok) await refresh();
    else setError(res.error ?? "Could not change routing strategy");
  }

  async function handleTest(id: string) {
    setTestingId(id);
    try {
      const result = await testProvider(id);
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: false, latencyMs: 0, error: "Failed" },
      }));
    }
    setTestingId(null);
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Providers</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Remote browser services the gateway routes connections to.
          </p>
        </div>
        {providers.length > 0 && (
          <Link
            href="/providers/new"
            className="inline-flex items-center gap-1.5 shrink-0 h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            Add provider
          </Link>
        )}
      </div>

      {providers.length > 0 && status && (
        <Card>
          <CardContent className="px-5 py-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Select
              value={status.strategy as Strategy}
              options={STRATEGY_OPTIONS}
              onChange={(v) => void handleStrategyChange(v)}
              disabled={savingStrategy}
              label="Routing"
              width="min-w-[18rem]"
            />
            <span className="text-xs text-muted-foreground">
              {STRATEGY_OPTIONS.find((o) => o.value === status.strategy)?.hint ??
                "How the gateway picks which provider handles each session."}
            </span>
          </CardContent>
        </Card>
      )}

      {error && (
        <Card className="border-destructive/50">
          <CardContent className="px-4 py-3">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {providers.length === 0 ? (
        <Card>
          <CardContent className="p-8 flex flex-col items-center text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
              <Server className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
            </div>
            <p className="text-lg font-medium">No providers yet.</p>
            <p className="text-sm text-muted-foreground mt-1.5 max-w-lg">
              Connect a self-hosted Playwright server, a cloud browser service, or a local
              Chrome instance with remote debugging enabled.
            </p>
            <Link
              href="/providers/new"
              className="mt-6 inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
            >
              <Plus className="h-3.5 w-3.5" />
              Add provider
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              status={statusMap[provider.id]}
              siblings={siblings}
              testResult={testResults[provider.id]}
              testing={testingId === provider.id}
              onTest={() => void handleTest(provider.id)}
              onDelete={() => setDeleteTarget(provider.id)}
            />
          ))}
        </div>
      )}

      <ProviderDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        providerId={deleteTarget}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
