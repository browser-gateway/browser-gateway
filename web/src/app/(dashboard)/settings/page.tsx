"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { proxyPickerOptions } from "@/lib/proxy-options";
import { Select, type SelectOption } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { STRATEGY_OPTIONS } from "@/lib/strategies";
import {
  fetchProfiles,
  fetchProviders,
  fetchProxies,
  fetchSettings,
  saveAdvancedSettings,
  saveSessionDefaults,
  setStrategy,
  type AdvancedSettings,
  type GatewaySettings,
  type ProfileMetaItem,
  type ProviderConfigItem,
  type ProxySummary,
  type SessionDefaults,
  type Strategy,
} from "@/lib/api";

const NONE = "";

interface Loaded {
  settings: GatewaySettings;
  profiles: ProfileMetaItem[];
  proxies: ProxySummary[];
  providers: ProviderConfigItem[];
}

function Row({ title, hint, children }: { title: string; hint: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 px-5 py-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <div className="text-xs text-muted-foreground mt-1 space-y-1">{hint}</div>
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

function Param({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-foreground/80">{children}</span>;
}

export default function SettingsPage() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      Promise.all([fetchSettings(), fetchProfiles(), fetchProxies(), fetchProviders()]).then(
        ([settings, profiles, proxies, providers]) =>
          setLoaded({ settings, profiles: profiles.profiles, proxies: proxies.proxies, providers: providers.providers }),
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      ),
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Defaults for new sessions, how sessions are routed, and gateway limits.</p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {!loaded && !error && (
        <Card><CardContent className="p-6 text-sm text-muted-foreground">Loading...</CardContent></Card>
      )}

      {loaded && (
        <Tabs defaultValue="defaults" className="w-full">
          <TabsList variant="line" className="border-b border-border/40 rounded-none gap-4 px-0 mb-4">
            <TabsTrigger value="defaults" className="px-1 pb-2 data-active:!text-foreground">Session defaults</TabsTrigger>
            <TabsTrigger value="routing" className="px-1 pb-2 data-active:!text-foreground">Routing</TabsTrigger>
            <TabsTrigger value="advanced" className="px-1 pb-2 data-active:!text-foreground">Advanced</TabsTrigger>
          </TabsList>
          <TabsContent value="defaults">
            <SessionDefaultsTab loaded={loaded} onSaved={refresh} />
          </TabsContent>
          <TabsContent value="routing">
            <RoutingTab strategy={loaded.settings.strategy} onSaved={refresh} />
          </TabsContent>
          <TabsContent value="advanced">
            <AdvancedTab settings={loaded.settings} onSaved={refresh} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function SessionDefaultsTab({ loaded, onSaved }: { loaded: Loaded; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<SessionDefaults>(loaded.settings.sessionDefaults);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const applying = loaded.providers.filter((p) => p.injectProxy && p.enabled).map((p) => p.id);
  const profilesEnabled = loaded.settings.profilesEnabled;

  const profileOptions: SelectOption[] = [
    { value: NONE, label: "None" },
    ...loaded.profiles.map((p) => ({ value: p.id, label: p.id })),
  ];
  const proxyOptions: SelectOption[] = [
    { value: NONE, label: "None" },
    ...proxyPickerOptions(loaded.proxies),
  ];

  async function save(next: SessionDefaults) {
    setDraft(next);
    setSaving(true);
    setMessage(null);
    const res = await saveSessionDefaults(next);
    setSaving(false);
    if (res.ok) {
      setMessage({ ok: true, text: "Saved. Applies to new sessions." });
      await onSaved();
    } else {
      setDraft(loaded.settings.sessionDefaults);
      setMessage({ ok: false, text: [res.error, ...(res.details ?? [])].filter(Boolean).join(": ") });
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Every new session uses these unless its connection URL says otherwise. All are off until you turn them on.
      </p>
      <Card>
        <CardContent className="p-0 divide-y divide-border/60">
          <Row
            title="Record sessions"
            hint={<p>Save a replay of every session. A single connection can opt out with <Param>session_record=false</Param>.</p>}
          >
            <Switch checked={draft.record} onCheckedChange={(v) => void save({ ...draft, record: v })} disabled={saving} aria-label="Record sessions" />
          </Row>

          <Row
            title="Default profile"
            hint={
              profilesEnabled ? (
                <p>Load this profile into sessions that name no profile. Opt out with <Param>profile=none</Param>; a connection that names a profile uses that one.</p>
              ) : (
                <p>Profiles are off. Turn them on in <Link href="/profiles" className="underline underline-offset-2 hover:text-foreground">Profiles</Link> first.</p>
              )
            }
          >
            <Select
              value={draft.profile ?? NONE}
              options={profileOptions}
              onChange={(v) => void save({ ...draft, profile: v || null, saveProfile: v ? draft.saveProfile : false })}
              disabled={saving || !profilesEnabled}
              width="min-w-[12rem]"
            />
          </Row>

          <Row
            title="Save changes to the default profile"
            hint={<p>Off: the default profile opens read-only and nothing is saved, so many sessions can share it. Override per connection with <Param>readOnly=0</Param> or <Param>readOnly=1</Param>.</p>}
          >
            <Switch
              checked={draft.saveProfile}
              onCheckedChange={(v) => void save({ ...draft, saveProfile: v })}
              disabled={saving || !draft.profile}
              aria-label="Save changes to the default profile"
            />
          </Row>

          <Row
            title="Default proxy"
            hint={
              <>
                <p>Send sessions that name no proxy through this proxy. Opt out with <Param>proxy=none</Param>.</p>
                {draft.proxy && (applying.length > 0 ? (
                  <p>While set, sessions go only to providers with Apply proxies on: <Param>{applying.join(", ")}</Param>.</p>
                ) : (
                  <p>No provider has Apply proxies on, so new sessions are refused while this is set.</p>
                ))}
                {loaded.proxies.length === 0 && (
                  <p>No proxies saved. Add one in <Link href="/proxies" className="underline underline-offset-2 hover:text-foreground">Proxies</Link>.</p>
                )}
              </>
            }
          >
            <Select
              value={draft.proxy ?? NONE}
              options={proxyOptions}
              onChange={(v) => void save({ ...draft, proxy: v || null })}
              disabled={saving || loaded.proxies.length === 0}
              width="min-w-[12rem]"
              align="right"
            />
          </Row>
        </CardContent>
      </Card>
      {message && <p className={`text-xs ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p>}
    </div>
  );
}

function RoutingTab({ strategy, onSaved }: { strategy: Strategy; onSaved: () => Promise<void> }) {
  const [value, setValue] = useState(strategy);
  const [message, setMessage] = useState<string | null>(null);

  async function change(next: Strategy) {
    setValue(next);
    const res = await setStrategy(next);
    setMessage(res.ok ? "Saved. Applies to new sessions." : res.error ?? "Could not save");
    if (res.ok) await onSaved();
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-0">
          <Row title="Routing strategy" hint={<p>{STRATEGY_OPTIONS.find((o) => o.value === value)?.hint}</p>}>
            <Select value={value} options={STRATEGY_OPTIONS} onChange={(v) => void change(v)} width="min-w-[12rem]" align="right" />
          </Row>
        </CardContent>
      </Card>
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}

type FieldUnit = "seconds" | "count" | "percent";

const ADVANCED_FIELDS: { key: keyof AdvancedSettings; title: string; hint: string; unit: FieldUnit }[] = [
  { key: "connectionTimeout", title: "Connection timeout", hint: "How long to wait for a provider to accept a session before trying the next one.", unit: "seconds" },
  { key: "sessionIdleTimeoutMs", title: "Idle session timeout", hint: "Close a session after this long with no traffic.", unit: "seconds" },
  { key: "queueMaxSize", title: "Queue size", hint: "Sessions that may wait for a free provider. 0 refuses at once when every provider is full.", unit: "count" },
  { key: "queueTimeoutMs", title: "Queue wait", hint: "How long a waiting session waits before it is refused.", unit: "seconds" },
  { key: "healthCheckInterval", title: "Health check interval", hint: "How often providers are checked.", unit: "seconds" },
  { key: "cooldownMs", title: "Cooldown length", hint: "How long a failing provider is skipped.", unit: "seconds" },
  { key: "cooldownFailureThreshold", title: "Failure rate that starts a cooldown", hint: "Share of recent sessions that must fail.", unit: "percent" },
  { key: "cooldownMinRequestVolume", title: "Sessions before a cooldown can start", hint: "Recent sessions needed before the failure rate counts.", unit: "count" },
];

function toDisplay(value: number, unit: FieldUnit): string {
  if (unit === "seconds") return String(value / 1000);
  if (unit === "percent") return String(Math.round(value * 100));
  return String(value);
}

function fromDisplay(text: string, unit: FieldUnit): number {
  const n = Number(text);
  if (unit === "seconds") return Math.round(n * 1000);
  if (unit === "percent") return n / 100;
  return Math.round(n);
}

const UNIT_LABEL: Record<FieldUnit, string> = { seconds: "s", count: "", percent: "%" };

function AdvancedTab({ settings, onSaved }: { settings: GatewaySettings; onSaved: () => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(ADVANCED_FIELDS.map((f) => [f.key, toDisplay(settings.advanced[f.key], f.unit)])),
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const changed: Partial<AdvancedSettings> = {};
    for (const f of ADVANCED_FIELDS) {
      const next = fromDisplay(values[f.key] ?? "", f.unit);
      if (Number.isNaN(next)) {
        setMessage({ ok: false, text: `${f.title}: enter a number` });
        return;
      }
      if (next !== settings.advanced[f.key]) changed[f.key] = next;
    }
    setSaving(true);
    const res = await saveAdvancedSettings(changed);
    setSaving(false);
    if (res.ok) {
      setMessage({ ok: true, text: "Saved." });
      await onSaved();
    } else {
      setMessage({ ok: false, text: [res.error, ...(res.details ?? [])].filter(Boolean).join(": ") });
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-3">
      <Card>
        <CardContent className="p-0 divide-y divide-border/60">
          {ADVANCED_FIELDS.map((f) => (
            <Row
              key={f.key}
              title={f.title}
              hint={
                <p>
                  {f.hint}
                  {settings.appliesAfterRestart.includes(f.key) ? " Applies after a restart." : " Applies to new sessions."}
                </p>
              }
            >
              <div className="flex items-center gap-2">
                <Input
                  aria-label={f.title}
                  inputMode="decimal"
                  value={values[f.key]}
                  onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  className="w-28 h-9 text-right font-mono"
                />
                <span className="w-3 text-xs text-muted-foreground">{UNIT_LABEL[f.unit]}</span>
              </div>
            </Row>
          ))}
        </CardContent>
      </Card>
      <div className="flex items-center justify-end gap-3">
        {message && <p className={`text-xs ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p>}
        <Button type="submit" size="sm" disabled={saving} className="gap-1.5">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Save changes
        </Button>
      </div>
    </form>
  );
}
