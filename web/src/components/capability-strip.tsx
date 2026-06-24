"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import {
  fetchProviderCapabilities,
  revalidateProviderCapabilities,
  type CapabilityState,
  type ProviderCapabilities,
  type ProviderCapabilitiesResponse,
} from "@/lib/api";

interface Props {
  providerId: string;
}

type FeatureKey = keyof Pick<
  ProviderCapabilities,
  "browserCookies" | "targetCreate" | "fetchInterception" | "pageScreencast"
>;

const FEATURES: { key: FeatureKey; label: string; description: string }[] = [
  { key: "browserCookies", label: "Cookies", description: "Storage.setCookies / getCookies" },
  { key: "targetCreate", label: "Tabs", description: "Open helper pages via Target.createTarget" },
  { key: "fetchInterception", label: "Fetch", description: "Fetch.fulfillRequest on attached sessions (used by profile inject)" },
  { key: "pageScreencast", label: "Live view", description: "Page.startScreencast — used by /v1/live playground" },
];

function FeatureChip({
  label,
  state,
  title,
}: {
  label: string;
  state: CapabilityState | "unknown";
  title: string;
}) {
  const stateLabel = state === "supported" ? "ok" : state === "unsupported" ? "no" : "?";
  const chipClass =
    state === "supported"
      ? "bg-muted/40 text-foreground/80"
      : state === "unsupported"
      ? "bg-destructive/10 text-destructive"
      : "bg-muted/40 text-muted-foreground/60";
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10.5px] font-mono ${chipClass}`}
    >
      <span>{label}</span>
      <span className="opacity-70 uppercase tracking-wider text-[9.5px]">{stateLabel}</span>
    </span>
  );
}

export function CapabilityStrip({ providerId }: Props) {
  const [data, setData] = useState<ProviderCapabilitiesResponse | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchProviderCapabilities(providerId)
      .then((r) => alive && setData(r))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [providerId]);

  // Poll while probing.
  useEffect(() => {
    if (data?.status !== "probing") return;
    const t = setInterval(async () => {
      try {
        const r = await fetchProviderCapabilities(providerId);
        setData(r);
      } catch {
        // ignore
      }
    }, 1500);
    return () => clearInterval(t);
  }, [data?.status, providerId]);

  async function onRevalidate() {
    setBusy(true);
    try {
      const r = await revalidateProviderCapabilities(providerId);
      setData(r);
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div className="flex items-center gap-1">
        {FEATURES.map((f) => (
          <FeatureChip key={f.key} label={f.label} state="unknown" title={`${f.label}: unknown`} />
        ))}
      </div>
    );
  }

  if (data.status === "pending" || data.status === "probing") {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Probing…
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-1 flex-wrap">
        {FEATURES.map((f) => {
          const state = data.capabilities?.[f.key];
          return (
            <FeatureChip
              key={f.key}
              label={f.label}
              state={state ?? "unknown"}
              title={`${f.label}: ${state ?? "unknown"} — ${f.description}`}
            />
          );
        })}
      </div>
      <button
        type="button"
        onClick={onRevalidate}
        disabled={busy}
        className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        title="Re-probe this provider's capabilities"
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
      </button>
    </div>
  );
}
