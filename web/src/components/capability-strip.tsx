"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Loader2, Check, X, Minus } from "lucide-react";
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
  { key: "browserCookies", label: "Cookies", description: "Saves and restores cookies. Needed for profiles." },
  { key: "targetCreate", label: "Multiple tabs", description: "Can open extra tabs while loading a profile." },
  { key: "fetchInterception", label: "Storage restore", description: "Restores saved site storage when loading a profile." },
  { key: "pageScreencast", label: "Live view", description: "Streams the screen for the live playground." },
];

function FeatureItem({
  label,
  state,
  title,
}: {
  label: string;
  state: CapabilityState | "unknown";
  title: string;
}) {
  const Icon = state === "supported" ? Check : state === "unsupported" ? X : Minus;
  return (
    <span title={title} className="inline-flex items-center gap-1.5">
      <Icon
        className={`size-3.5 shrink-0 ${state === "supported" ? "text-foreground" : "text-muted-foreground/40"}`}
      />
      <span className={state === "supported" ? "text-foreground/90" : "text-muted-foreground"}>{label}</span>
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
      <div className="flex items-center gap-x-4 gap-y-1.5 flex-wrap text-xs">
        {FEATURES.map((f) => (
          <FeatureItem key={f.key} label={f.label} state="unknown" title={`${f.label}: not tested yet`} />
        ))}
      </div>
    );
  }

  if (data.status === "pending" || data.status === "probing") {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Checking…
      </div>
    );
  }

  const noResult = data.capabilities === null;
  const failureNote = data.capabilities?.errors?.length ? data.capabilities.errors.join("; ") : null;

  return (
    <div className="flex items-center gap-x-4 gap-y-1.5 flex-wrap text-xs">
      {FEATURES.map((f) => {
        const state = data.capabilities?.[f.key];
        return (
          <FeatureItem
            key={f.key}
            label={f.label}
            state={state ?? "unknown"}
            title={`${f.label}: ${state ?? (noResult ? "could not check" : "not tested yet")}. ${f.description}`}
          />
        );
      })}
      {noResult && (
        <span className="text-muted-foreground" title={failureNote ?? "Try again, or use Test to check the connection."}>
          Could not check
        </span>
      )}
      <button
        type="button"
        onClick={onRevalidate}
        disabled={busy}
        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        title="Check again what this provider supports"
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
        <span>Check again</span>
      </button>
    </div>
  );
}
