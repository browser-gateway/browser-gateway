"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import {
  fetchProviders,
  fetchProfiles,
  type ProviderConfigItem,
  type ProfileMetaItem,
} from "@/lib/api";
import { ProviderForm } from "@/components/provider-form";
import type { SiblingProvider } from "@shared/provider-form";

export default function NewProviderPage() {
  const [siblings, setSiblings] = React.useState<SiblingProvider[]>([]);
  const [profiles, setProfiles] = React.useState<ProfileMetaItem[]>([]);
  const [profilesEnabled, setProfilesEnabled] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [p, profs] = await Promise.all([fetchProviders(), fetchProfiles()]);
        if (cancelled) return;
        setSiblings(
          p.providers.map((x: ProviderConfigItem) => ({
            slug: x.id,
            priority: x.priority,
            weight: x.weight,
          })),
        );
        setProfiles(profs.profiles);
        setProfilesEnabled(profs.enabled);
      } catch {
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

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
        <h1 className="text-xl font-semibold tracking-tight">Add provider</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Connect a remote browser service the gateway will route to.
        </p>
      </div>

      {loaded ? (
        <ProviderForm
          initial={null}
          siblings={siblings}
          availableProfiles={profiles}
          profilesEnabled={profilesEnabled}
        />
      ) : (
        <div className="text-sm text-muted-foreground">Loading…</div>
      )}
    </div>
  );
}
