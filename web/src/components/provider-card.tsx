"use client";

import Link from "next/link";
import { Check, Loader2, Pencil, Trash2, X, Zap } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CapabilityStrip } from "@/components/capability-strip";
import type { ProviderConfigItem, ProviderStatus } from "@/lib/api";
import { computePriorityEffect, computeWeightEffect, type SiblingProvider } from "@shared/provider-form";

interface Props {
  provider: ProviderConfigItem;
  status: ProviderStatus | undefined;
  siblings: SiblingProvider[];
  testResult: { ok: boolean; latencyMs: number; error?: string } | undefined;
  testing: boolean;
  onTest: () => void;
  onDelete: () => void;
}

export function ProviderCard({
  provider,
  status,
  siblings,
  testResult,
  testing,
  onTest,
  onDelete,
}: Props) {
  const priorityEffect = computePriorityEffect(
    provider.priority,
    siblings.map((s) => s.priority),
  );
  const weightEffect = computeWeightEffect(
    provider.priority,
    provider.weight,
    siblings,
  );

  const dotClass = status?.cooldownUntil || status?.healthy === false
    ? "bg-destructive animate-pulse"
    : status
    ? "bg-foreground"
    : "bg-muted-foreground/40";

  const stateLabel = status?.cooldownUntil
    ? "Paused"
    : status?.healthy === false
    ? "Not reachable"
    : status
    ? "Ready"
    : "Checking";

  const headerCount = provider.headers ? Object.keys(provider.headers).length : 0;

  return (
    <Card>
      <CardContent className="px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0 space-y-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className={`h-2 w-2 rounded-full shrink-0 ${dotClass}`} />
              <Link
                href={`/providers/edit?slug=${encodeURIComponent(provider.id)}`}
                className="text-sm font-semibold font-mono truncate hover:underline"
              >
                {provider.id}
              </Link>
              <span className="text-[11px] text-muted-foreground shrink-0">
                {stateLabel}
              </span>
            </div>

            <p className="text-xs text-muted-foreground font-mono truncate">
              {provider.url}
            </p>

            <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-muted-foreground">Type</dt>
              <dd className="text-foreground">
                {provider.detectedKind === "browserserve"
                  ? "Self-hosted browserserve"
                  : "External browser service"}
              </dd>

              <dt className="text-muted-foreground">Priority</dt>
              <dd className="text-foreground">
                {provider.priority}
                <span className="text-muted-foreground"> · {priorityEffect.label}</span>
              </dd>

              <dt className="text-muted-foreground">Weight</dt>
              <dd className="text-foreground">
                {provider.weight}
                <span className="text-muted-foreground"> · {weightEffect.label}</span>
              </dd>

              <dt className="text-muted-foreground">Serves</dt>
              <dd className="text-foreground">
                {provider.multiProfile ? (
                  "Any profile"
                ) : provider.profile ? (
                  <>Only <span className="font-mono">{provider.profile}</span></>
                ) : (
                  "Sessions with no profile"
                )}
              </dd>

              <dt className="text-muted-foreground">Capacity</dt>
              <dd className="text-foreground">
                {status?.active ?? 0} in use / {provider.maxConcurrent ?? "no limit"}
                {provider.maxConcurrentSource === "discovered" && (
                  <span className="text-muted-foreground"> · set automatically</span>
                )}
              </dd>

              {headerCount > 0 && (
                <>
                  <dt className="text-muted-foreground">Custom headers</dt>
                  <dd className="text-foreground">
                    {headerCount} configured
                  </dd>
                </>
              )}

              {status && status.totalConnections > 0 && (
                <>
                  <dt className="text-muted-foreground">Traffic</dt>
                  <dd className="text-foreground">
                    {status.totalConnections} sent · {status.avgLatencyMs}ms average
                  </dd>
                </>
              )}
            </dl>

            {status?.cooldownUntil && (
              <p className="text-xs text-destructive">
                Paused after repeated failures. Will be retried automatically.
              </p>
            )}

            {testResult && (
              <p
                className={`inline-flex items-center gap-1.5 text-xs ${
                  testResult.ok ? "text-foreground" : "text-destructive"
                }`}
              >
                {testResult.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                {testResult.ok
                  ? `Connected in ${testResult.latencyMs}ms`
                  : `Could not connect: ${testResult.error ?? "unknown"}`}
              </p>
            )}

            <div className="space-y-1.5 pt-0.5">
              <div className="text-[11px] text-muted-foreground">Supports</div>
              <CapabilityStrip providerId={provider.id} />
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onTest}
              disabled={testing}
              title="Test connection"
            >
              {testing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="h-3.5 w-3.5" />
              )}
            </Button>
            <Link
              href={`/providers/edit?slug=${encodeURIComponent(provider.id)}`}
              className="inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-muted/40 text-muted-foreground hover:text-foreground"
              title="Edit provider"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Link>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-destructive hover:text-destructive"
              onClick={onDelete}
              title="Remove provider"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
