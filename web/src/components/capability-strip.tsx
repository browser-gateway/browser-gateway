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

function Dot({ state, title }: { state: CapabilityState | "unknown"; title: string }) {
  const cls =
    state === "supported"
      ? "bg-foreground"
      : state === "unsupported"
      ? "bg-destructive"
      : "bg-muted-foreground/40";
  return (
    <span
      className={`inline-block size-1.5 rounded-full ${cls}`}
      title={title}
    />
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
      <div className="flex items-center gap-1.5">
        {FEATURES.map((f) => (
          <Dot key={f.key} state="unknown" title={`${f.label}: unknown`} />
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
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1.5">
        {FEATURES.map((f) => {
          const state = data.capabilities?.[f.key];
          return (
            <Dot
              key={f.key}
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
