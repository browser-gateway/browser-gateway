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
import { cn } from "@/lib/utils";

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

const CHIP = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-line bg-ground px-[9px] py-[3px] text-xs font-semibold";

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
  const supported = state === "supported";
  return (
    <span title={title} className={cn(CHIP, supported ? "text-fg-2" : "text-fg-3")}>
      <Icon className={cn("size-3 shrink-0", supported ? "text-good" : "text-fg-3")} strokeWidth={2.4} />
      {label}
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

  useEffect(() => {
    if (data?.status !== "probing") return;
    const t = setInterval(async () => {
      try {
        const r = await fetchProviderCapabilities(providerId);
        setData(r);
      } catch {}
    }, 1500);
    return () => clearInterval(t);
  }, [data?.status, providerId]);

  async function onRevalidate() {
    setBusy(true);
    try {
      const r = await revalidateProviderCapabilities(providerId);
      setData(r);
    } catch {
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {FEATURES.map((f) => (
          <FeatureItem key={f.key} label={f.label} state="unknown" title={`${f.label}: not tested yet`} />
        ))}
      </div>
    );
  }

  if (data.status === "pending" || data.status === "probing") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-fg-3">
        <Loader2 className="size-3 animate-spin" />
        Checking what this provider supports
      </div>
    );
  }

  const noResult = data.capabilities === null;
  const failureNote = data.capabilities?.errors?.length ? data.capabilities.errors.join("; ") : null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
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
        <span className="text-xs text-fg-3" title={failureNote ?? "Try again, or use Test to check the connection."}>
          Could not check
        </span>
      )}
      <button
        type="button"
        onClick={onRevalidate}
        disabled={busy}
        className="t-link inline-flex items-center gap-1 text-xs disabled:opacity-50"
        title="Check again what this provider supports"
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
        Check again
      </button>
    </div>
  );
}
