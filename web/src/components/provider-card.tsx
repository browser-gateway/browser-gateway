"use client";

import { Check, Loader2, X } from "lucide-react";
import { StatusBadge, type Tone } from "@/components/ui/badge";
import { LogoTile } from "@/components/ui/logo-tile";
import { RowMenu } from "@/components/ui/row-menu";
import { Switch } from "@/components/ui/switch";
import { CapabilityStrip } from "@/components/capability-strip";
import type { ProviderConfigItem, ProviderStatus } from "@/lib/api";
import { computePriorityEffect, computeWeightEffect, type SiblingProvider } from "@shared/provider-form";
import { cn } from "@/lib/utils";

export const ROUTE_COLS =
  "min-[1100px]:grid min-[1100px]:grid-cols-[44px_minmax(200px,1.6fr)_112px_104px_minmax(130px,1fr)_76px_48px_auto] min-[1100px]:items-center min-[1100px]:gap-x-3";

const CHIP = "whitespace-nowrap rounded-[10px] border border-line bg-ground px-[9px] py-[3px] text-xs font-semibold text-fg-soft";

interface Props {
  provider: ProviderConfigItem;
  status: ProviderStatus | undefined;
  siblings: SiblingProvider[];
  testResult: { ok: boolean; latencyMs: number; error?: string } | undefined;
  testing: boolean;
  toggling: boolean;
  onTest: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}

function briefHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function stateOf(enabled: boolean, status: ProviderStatus | undefined): { label: string; tone: Tone } {
  if (!enabled) return { label: "Off", tone: "warn" };
  if (status?.cooldownUntil) return { label: "Paused", tone: "warn" };
  if (status?.healthy === false) return { label: "Not reachable", tone: "bad" };
  if (status) return { label: "Ready", tone: "good" };
  return { label: "Checking", tone: "neutral" };
}

export function ProviderCard({
  provider,
  status,
  siblings,
  testResult,
  testing,
  toggling,
  onTest,
  onToggleEnabled,
  onEdit,
  onDelete,
}: Props) {
  const enabled = provider.enabled !== false;
  const priorityEffect = computePriorityEffect(
    provider.priority,
    siblings.map((s) => s.priority),
  );
  const weightEffect = computeWeightEffect(provider.priority, provider.weight, siblings);
  const state = stateOf(enabled, status);
  const headerCount = provider.headers ? Object.keys(provider.headers).length : 0;
  const active = status?.active ?? 0;
  const max = provider.maxConcurrent;
  const usePct = max ? Math.min(100, Math.round((active / max) * 100)) : 0;

  return (
    <div
      className={cn(
        ROUTE_COLS,
        "flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line-divider px-1 py-3.5",
        !enabled && "[&>*:not(.keep)]:opacity-60",
      )}
      data-testid={`provider-row-${provider.id}`}
    >
      <LogoTile name={provider.id} size={44} className="!rounded-xl shadow-none" />
      <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-px">
        <button
          type="button"
          onClick={onEdit}
          className="w-fit max-w-full truncate text-left font-mono text-[15px] font-medium hover:underline"
        >
          {provider.id}
        </button>
        <span className="truncate text-xs text-fg-3">
          {provider.detectedKind === "browserserve" ? "Self-hosted browserserve" : "External browser service"} · {briefHost(provider.url)}
        </span>
      </div>
      <span className="flex">
        <StatusBadge tone={state.tone} className="whitespace-nowrap">{state.label}</StatusBadge>
      </span>
      <span className="font-mono text-[13px]" title="Priority · weight">
        {provider.priority} · w{provider.weight}
      </span>
      <div className="flex min-w-[130px] flex-col gap-1.5">
        <span className="font-mono text-[13px]">
          {active} in use / {max ?? "no limit"}
        </span>
        {max ? (
          <span
            className="block h-1.5 rounded-[3px] bg-track"
            role="meter"
            aria-label={`${provider.id} sessions in use`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={usePct}
          >
            <span className="block h-1.5 rounded-[3px] bg-brand-text" style={{ width: `${usePct}%` }} />
          </span>
        ) : null}
      </div>
      <span
        className="font-mono text-[13px] min-[1100px]:text-right"
        title={testResult ? (testResult.ok ? "From the last test" : testResult.error) : "Average connect time of sessions sent here"}
      >
        {testing ? (
          <Loader2 className="size-3.5 animate-spin min-[1100px]:ml-auto" />
        ) : testResult?.ok ? (
          `${testResult.latencyMs}ms`
        ) : status && status.totalConnections > 0 ? (
          `${status.avgLatencyMs}ms`
        ) : (
          "—"
        )}
      </span>
      <div className="keep flex min-[1100px]:justify-end">
        <Switch
          checked={enabled}
          disabled={toggling}
          onCheckedChange={(next) => onToggleEnabled(next)}
          label={enabled ? `Turn off ${provider.id}` : `Turn on ${provider.id}`}
          title={enabled ? "Receiving sessions. Switch off to stop routing here." : "Not receiving sessions. Switch on to route here again."}
          className="w-[42px]"
        />
      </div>
      <div className="keep ml-auto flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onEdit}
          className="h-[34px] rounded-[17px] border border-line-strong bg-transparent px-3.5 text-[13px] font-semibold text-fg hover:bg-raised"
        >
          Edit
        </button>
        <RowMenu
          items={[
            { label: testing ? "Testing connection" : "Test connection", onSelect: onTest },
            { label: "Remove provider", danger: true, onSelect: onDelete },
          ]}
        />
      </div>

      <div className="flex w-full min-w-0 flex-col gap-2 min-[1100px]:col-[2/-1] min-[1100px]:pt-1">
        <p className="m-0 text-xs text-fg-3">
          {enabled ? `${priorityEffect.label} ${weightEffect.label}` : "Not routed while off."}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={CHIP}>
            {provider.profile && !provider.multiProfile ? (
              <>Only <span className="font-mono">{provider.profile}</span></>
            ) : (
              "Any session"
            )}
          </span>
          {provider.injectProxy && (
            <span className={CHIP}>
              Applies proxies on <span className="font-mono">?proxy=</span>
            </span>
          )}
          {provider.maxConcurrentSource === "discovered" && <span className={CHIP}>Limit set automatically</span>}
          {headerCount > 0 && <span className={CHIP}>{headerCount} custom {headerCount === 1 ? "header" : "headers"}</span>}
          {status && status.totalConnections > 0 && (
            <span className={CHIP}>
              {status.totalConnections} sent · {status.avgLatencyMs}ms average
            </span>
          )}
        </div>
        <CapabilityStrip providerId={provider.id} />
        {status?.cooldownUntil && (
          <p className="m-0 text-xs text-warn">Paused after repeated failures. It is retried automatically.</p>
        )}
        {testResult && (
          <p className={cn("m-0 inline-flex items-center gap-1.5 text-xs font-semibold", testResult.ok ? "text-good" : "text-bad")}>
            {testResult.ok ? <Check className="h-3.5 w-3.5" strokeWidth={2.4} /> : <X className="h-3.5 w-3.5" strokeWidth={2.4} />}
            {testResult.ok
              ? `Connected in ${testResult.latencyMs}ms`
              : `Could not connect: ${testResult.error ?? "unknown"}`}
          </p>
        )}
      </div>
    </div>
  );
}
