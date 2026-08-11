"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  fetchProviders,
  fetchProfiles,
  type ProviderConfigItem,
  type ProfileMetaItem,
} from "@/lib/api";
import { ProviderForm } from "@/components/provider-form";
import type { SiblingProvider } from "@shared/provider-form";

export default function EditProviderPage() {
  const params = useSearchParams();
  const slug = params.get("slug");

  const [initial, setInitial] = React.useState<ProviderConfigItem | null>(null);
  const [siblings, setSiblings] = React.useState<SiblingProvider[]>([]);
  const [profiles, setProfiles] = React.useState<ProfileMetaItem[]>([]);
  const [profilesEnabled, setProfilesEnabled] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [notFound, setNotFound] = React.useState(false);

  React.useEffect(() => {
    if (!slug) {
      setLoaded(true);
      setNotFound(true);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const [p, profs] = await Promise.all([fetchProviders(), fetchProfiles()]);
        if (cancelled) return;
        const match = p.providers.find((x: ProviderConfigItem) => x.id === slug);
        if (!match) {
          setNotFound(true);
        } else {
          setInitial(match);
          setSiblings(
            p.providers.map((x: ProviderConfigItem) => ({
              slug: x.id,
              priority: x.priority,
              weight: x.weight,
            })),
          );
          setProfiles(profs.profiles);
          setProfilesEnabled(profs.enabled);
        }
      } catch {
        setNotFound(true);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/providers"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-2"
        >
          <ArrowLeft className="h-3 w-3" />
          Providers
        </Link>
        <h1 className="text-xl font-semibold tracking-tight font-mono">
          {slug ?? "Edit provider"}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Update the connection details for this provider.
        </p>
      </div>

      {!loaded && <div className="text-sm text-muted-foreground">Loading…</div>}
      {loaded && notFound && (
        <div className="text-sm text-destructive">Provider not found.</div>
      )}
      {loaded && initial && (
        <ProviderForm
          initial={initial}
          siblings={siblings}
          availableProfiles={profiles}
          profilesEnabled={profilesEnabled}
        />
      )}
    </div>
  );
}
