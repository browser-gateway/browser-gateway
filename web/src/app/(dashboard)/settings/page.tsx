"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { SaveBar } from "@/components/ui/save-bar";
import { Select, type SelectOption } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { proxyPickerOptions } from "@/lib/proxy-options";
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
import { cn } from "@/lib/utils";

const NONE = "";
const PAGE_DESCRIPTION = "Defaults for new sessions, how sessions pick a provider, and gateway limits.";

type SettingsTab = "defaults" | "routing" | "advanced";

const TAB_LABEL: Record<SettingsTab, string> = {
  defaults: "Session defaults",
  routing: "Routing",
  advanced: "Advanced",
};

interface Loaded {
  settings: GatewaySettings;
  profiles: ProfileMetaItem[];
  proxies: ProxySummary[];
  providers: ProviderConfigItem[];
}

function saveError(res: { error?: string; details?: string[] }): string {
  return [res.error, ...(res.details ?? [])].filter(Boolean).join(": ") || "Could not save.";
}

export default function SettingsPage() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<SettingsTab>("defaults");

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

  if (error) {
    return (
      <>
        <PageHeader title="Settings" description={PAGE_DESCRIPTION} />
        <Alert title="Settings did not load">{error}. Check that the gateway is running, then reload the page.</Alert>
      </>
    );
  }

  if (!loaded) {
    return (
      <div role="status" aria-label="Loading settings" className="flex flex-col gap-5">
        <PageHeader title="Settings" description={PAGE_DESCRIPTION} />
        <Skeleton className="h-[50px] w-full max-w-[420px] rounded-[26px]" />
        <Skeleton className="h-[420px] rounded-[28px]" />
      </div>
    );
  }

  return (
    <>
      <PageHeader title="Settings" description={PAGE_DESCRIPTION} />

      <div role="tablist" aria-label="Settings" className="flex w-fit max-w-full flex-wrap gap-1 rounded-[26px] border border-line bg-card p-1">
        {(Object.keys(TAB_LABEL) as SettingsTab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "h-10 flex-none whitespace-nowrap rounded-[20px] px-4 text-[13px] font-bold transition-colors",
              tab === t ? "bg-fg text-ground" : "text-fg-2 hover:text-fg",
            )}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {tab === "defaults" ? <SessionDefaultsTab loaded={loaded} onSaved={refresh} /> : null}
      {tab === "routing" ? <RoutingTab strategy={loaded.settings.strategy} providers={loaded.providers} onSaved={refresh} /> : null}
      {tab === "advanced" ? <AdvancedTab key={JSON.stringify(loaded.settings.advanced)} settings={loaded.settings} onSaved={refresh} /> : null}
    </>
  );
}

function SettingRow({
  title,
  note,
  control,
  first,
  children,
}: {
  title: React.ReactNode;
  note?: React.ReactNode;
  control?: React.ReactNode;
  first?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-6 gap-y-3 py-[18px]", !first && "border-t border-line-divider")}>
      <span className="flex min-w-0 flex-[1_1_320px] flex-col gap-[3px]">
        <span className="text-[15px] font-bold">{title}</span>
        {note ? <span className="text-xs text-fg-2">{note}</span> : null}
      </span>
      {control}
      {children}
    </div>
  );
}

function RowNote({ children }: { children: React.ReactNode }) {
  return <div className="basis-full rounded-2xl border border-line bg-ground px-4 py-3 text-xs text-fg-2">{children}</div>;
}

function Param({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-fg">{children}</span>;
}

function SessionDefaultsTab({ loaded, onSaved }: { loaded: Loaded; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<SessionDefaults>(loaded.settings.sessionDefaults);
  const [saving, setSaving] = useState(false);
  const applying = loaded.providers.filter((p) => p.injectProxy && p.enabled).map((p) => p.id);
  const profilesEnabled = loaded.settings.profilesEnabled;

  const profileOptions: SelectOption[] = [
    { value: NONE, label: "None", hint: "Sessions start signed out" },
    ...loaded.profiles.map((p) => ({ value: p.id, label: p.id })),
  ];
  const proxyOptions: SelectOption[] = [
    { value: NONE, label: "None", hint: "Sessions use the provider's own network" },
    ...proxyPickerOptions(loaded.proxies),
  ];

  async function save(next: SessionDefaults) {
    setDraft(next);
    setSaving(true);
    const res = await saveSessionDefaults(next);
    setSaving(false);
    if (res.ok) {
      toast.success("Session defaults saved.", { description: "Applies to new sessions." });
      await onSaved();
    } else {
      setDraft(loaded.settings.sessionDefaults);
      toast.error(saveError(res));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Session defaults" className="ui-card ui-card--hero rounded-[28px] px-6 py-2">
        <div className="flex flex-col gap-0.5 pb-1.5 pt-4">
          <h2 className="t-h2">Session defaults</h2>
          <span className="text-xs text-fg-3">
            Every new session uses these unless its connection address says otherwise. All are off until you turn them on.
          </span>
        </div>
        <SettingRow
          first
          title="Record sessions"
          note="Saves a replay of every session."
          control={<Switch checked={draft.record} onCheckedChange={(v) => void save({ ...draft, record: v })} disabled={saving} label="Record sessions" />}
        />
        <SettingRow
          title="Default profile"
          note="Sessions that name no profile start signed in with this one."
          control={
            <Select
              label="Default profile"
              hideLabel
              align="right"
              value={draft.profile ?? NONE}
              options={profileOptions}
              onChange={(v) => void save({ ...draft, profile: v || null, saveProfile: v ? draft.saveProfile : false })}
              disabled={saving || !profilesEnabled}
              footer={{ label: "Manage profiles", href: "/profiles/" }}
            />
          }
        >
          {!profilesEnabled ? (
            <RowNote>
              Profiles are off. Turn them on in{" "}
              <Link href="/profiles/" className="t-link text-xs">
                Profiles
              </Link>{" "}
              first.
            </RowNote>
          ) : loaded.profiles.length === 0 ? (
            <RowNote>
              No profiles saved.{" "}
              <Link href="/profiles/" className="t-link text-xs">
                Create one on the Profiles page
              </Link>
              .
            </RowNote>
          ) : null}
        </SettingRow>
        <SettingRow
          title="Save changes to the default profile"
          note={
            draft.profile
              ? "Writes cookies and storage back to the profile when a session closes. Off opens it read-only, so many sessions can share it."
              : "Pick a default profile first. Off opens the profile read-only."
          }
          control={
            <Switch
              checked={draft.saveProfile}
              onCheckedChange={(v) => void save({ ...draft, saveProfile: v })}
              disabled={saving || !draft.profile}
              label="Save changes to the default profile"
            />
          }
        />
        <SettingRow
          title="Default proxy"
          note="Sessions that name no proxy send their pages through this one."
          control={
            <Select
              label="Default proxy"
              hideLabel
              align="right"
              value={draft.proxy ?? NONE}
              options={proxyOptions}
              onChange={(v) => void save({ ...draft, proxy: v || null })}
              disabled={saving || loaded.proxies.length === 0}
              footer={{ label: "Manage proxies", href: "/proxies/" }}
            />
          }
        >
          {loaded.proxies.length === 0 ? (
            <RowNote>
              No proxies saved.{" "}
              <Link href="/proxies/" className="t-link text-xs">
                Add one on the Proxies page
              </Link>
              .
            </RowNote>
          ) : draft.proxy ? (
            <RowNote>
              {applying.length > 0 ? (
                <>
                  While set, sessions go only to providers with Apply proxies on: <Param>{applying.join(", ")}</Param>.
                </>
              ) : (
                "No provider has Apply proxies on, so new sessions are refused while this is set."
              )}
            </RowNote>
          ) : null}
        </SettingRow>
      </section>
      <OverrideCard />
    </div>
  );
}

const OVERRIDES: { setting: string; on: string; off: string }[] = [
  { setting: "Recording", on: "session_record=true", off: "session_record=false" },
  { setting: "Profile", on: "profile=<name>", off: "profile=none" },
  { setting: "Save changes", on: "readOnly=0", off: "readOnly=1" },
  { setting: "Proxy", on: "proxy=<name>", off: "proxy=none" },
];

const OVERRIDE_CHIP = "whitespace-nowrap rounded-[10px] border border-line bg-ground px-[9px] py-[3px] font-mono text-xs font-semibold";

function OverrideCard() {
  return (
    <section aria-label="Override per connection" className="ui-card flex flex-col gap-3 rounded-[24px] px-6 py-[22px]">
      <div className="flex flex-col gap-0.5">
        <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Override per connection</h2>
        <span className="text-xs text-fg-3">Add these to the connect address. A connection that names a profile uses that one instead of the default.</span>
      </div>
      <div role="table" aria-label="Connection overrides" className="flex flex-col">
        <div role="row" className="t-th flex gap-3 border-b border-line-divider px-1 py-2">
          <span role="columnheader" className="flex-[1_1_120px]">
            Setting
          </span>
          <span role="columnheader" className="flex-[1.4_1_160px]">
            Turn on
          </span>
          <span role="columnheader" className="flex-[1.4_1_160px]">
            Turn off
          </span>
        </div>
        {OVERRIDES.map((o) => (
          <div key={o.setting} role="row" className="flex flex-wrap gap-x-3 gap-y-1 border-b border-line-faint px-1 py-[11px]">
            <span role="cell" className="flex-[1_1_120px] text-[13px] font-semibold">
              {o.setting}
            </span>
            <span role="cell" className="flex-[1.4_1_160px]">
              <span className={`${OVERRIDE_CHIP} text-good`}>{o.on}</span>
            </span>
            <span role="cell" className="flex-[1.4_1_160px]">
              <span className={`${OVERRIDE_CHIP} text-fg-2`}>{o.off}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function RoutingTab({ strategy, providers, onSaved }: { strategy: Strategy; providers: ProviderConfigItem[]; onSaved: () => Promise<void> }) {
  const [value, setValue] = useState(strategy);
  const [saving, setSaving] = useState(false);

  async function pick(next: Strategy) {
    if (saving || next === value) return;
    const previous = value;
    setValue(next);
    setSaving(true);
    try {
      const res = await setStrategy(next);
      if (res.ok) {
        toast.success("Routing strategy saved.", { description: "Applies to new sessions." });
        await onSaved();
      } else {
        setValue(previous);
        toast.error(res.error ?? "Could not save.");
      }
    } finally {
      setSaving(false);
    }
  }

  const ordered = providers
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.priority - b.p.priority || a.i - b.i)
    .map(({ p }) => p);

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Routing strategy" className="ui-card ui-card--hero flex flex-col gap-3.5 rounded-[28px] px-6 py-[22px]">
        <div className="flex flex-col gap-0.5">
          <h2 className="t-h2">How sessions pick a provider</h2>
          <span className="text-xs text-fg-3">Applies whenever more than one provider can take the session.</span>
        </div>
        <div role="radiogroup" aria-label="Routing strategy" className="grid grid-cols-[repeat(auto-fill,minmax(min(250px,100%),1fr))] gap-2.5">
          {STRATEGY_OPTIONS.map((s) => {
            const checked = value === s.value;
            return (
              <button
                key={s.value}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={saving}
                onClick={() => void pick(s.value)}
                className={cn(
                  "flex flex-col gap-2 rounded-[20px] border p-4 text-left text-fg transition-colors disabled:cursor-not-allowed",
                  checked ? "border-brand-text bg-brand-soft" : "border-line bg-ground hover:border-line-strong",
                )}
              >
                <span className="flex items-center gap-2.5">
                  <span className={cn("flex size-5 flex-none items-center justify-center rounded-[10px] border-2", checked ? "border-brand-text" : "border-line-control")}>
                    <span className={cn("size-2 rounded", checked ? "bg-brand-text" : "bg-transparent")} />
                  </span>
                  <span className="text-[15px] font-bold">{s.label}</span>
                </span>
                <span className="text-xs text-fg-2">{s.hint}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-label="Provider order" className="ui-card flex flex-col gap-3 rounded-[24px] px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Providers</h2>
          <Link href="/providers/" className="t-link text-xs">
            Manage providers →
          </Link>
        </div>
        {ordered.length === 0 ? (
          <span className="text-xs text-fg-3">No providers yet. Providers you add show here in the order they are tried.</span>
        ) : (
          <>
            {ordered.map((p, i) => (
              <div key={p.id} className="flex items-center gap-3 rounded-2xl border border-line bg-ground px-3.5 py-3">
                <span className="flex size-7 flex-none items-center justify-center rounded-full bg-brand-soft font-mono text-xs text-brand-text">{i + 1}</span>
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="truncate text-sm font-bold">{p.id}</span>
                  <span className="text-xs text-fg-3">
                    Priority {p.priority} · weight {p.weight}
                  </span>
                </span>
                {p.enabled ? (
                  <span className="rounded-[10px] bg-good-bg px-[9px] py-[3px] text-xs font-bold text-good">On</span>
                ) : (
                  <span className="rounded-[10px] bg-raised px-[9px] py-[3px] text-xs font-bold text-fg-2">Off</span>
                )}
              </div>
            ))}
            {ordered.length === 1 ? (
              <span className="text-xs text-fg-3">With one provider the strategy has nothing to choose between. Add a second to fail over when this one is busy or down.</span>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

type FieldUnit = "seconds" | "count" | "percent";

interface AdvancedField {
  key: keyof AdvancedSettings;
  title: string;
  hint: string;
  unit: FieldUnit;
  unitLabel: string;
}

const ADVANCED_GROUPS: { title: string; note: string; fields: AdvancedField[] }[] = [
  {
    title: "Failover cooldown",
    note: "When a provider starts failing, rest it for a while before routing to it again.",
    fields: [
      { key: "cooldownMs", title: "Rest a failing provider for", hint: "How long a failing provider is skipped. Example: 30", unit: "seconds", unitLabel: "seconds" },
      { key: "cooldownFailureThreshold", title: "Failure rate that starts a rest", hint: "Share of recent sessions that must fail. Example: 50 is half of them.", unit: "percent", unitLabel: "%" },
      { key: "cooldownMinRequestVolume", title: "Sessions before judging", hint: "Recent sessions needed before the failure rate counts. Example: 5", unit: "count", unitLabel: "sessions" },
    ],
  },
  {
    title: "Idle sessions",
    note: "Close browser sessions that go quiet.",
    fields: [
      { key: "sessionIdleTimeoutMs", title: "Close after no traffic for", hint: "A session with no traffic this long is closed. Example: 300", unit: "seconds", unitLabel: "seconds" },
    ],
  },
  {
    title: "Queue",
    note: "Hold new connections when every provider is full, instead of failing them at once.",
    fields: [
      { key: "queueMaxSize", title: "How many can wait", hint: "Set 0 to refuse at once when every provider is full. Example: 50", unit: "count", unitLabel: "connections" },
      { key: "queueTimeoutMs", title: "Give up waiting after", hint: "Then the connection is refused. Example: 30", unit: "seconds", unitLabel: "seconds" },
    ],
  },
  {
    title: "Health and connection",
    note: "How often providers are checked and how long the gateway waits to connect.",
    fields: [
      { key: "healthCheckInterval", title: "Check provider health every", hint: "How often each provider is checked. Example: 30", unit: "seconds", unitLabel: "seconds" },
      { key: "connectionTimeout", title: "Provider connect timeout", hint: "How long to wait for a provider before trying the next one. Example: 10", unit: "seconds", unitLabel: "seconds" },
    ],
  },
];

const ADVANCED_FIELDS = ADVANCED_GROUPS.flatMap((g) => g.fields);

function toDisplay(value: number, unit: FieldUnit): string {
  if (unit === "seconds") return String(value / 1000);
  if (unit === "percent") return String(Math.round(value * 100));
  return String(value);
}

function fromDisplay(text: string, unit: FieldUnit): number {
  if (text.trim() === "") return Number.NaN;
  const n = Number(text);
  if (unit === "seconds") return Math.round(n * 1000);
  if (unit === "percent") return n / 100;
  return Math.round(n);
}

function AdvancedTab({ settings, onSaved }: { settings: GatewaySettings; onSaved: () => Promise<void> }) {
  const initial = Object.fromEntries(ADVANCED_FIELDS.map((f) => [f.key, toDisplay(settings.advanced[f.key], f.unit)])) as Record<string, string>;
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [saving, setSaving] = useState(false);

  const changed = (f: AdvancedField) => values[f.key] !== initial[f.key];
  const invalid = (f: AdvancedField) => changed(f) && Number.isNaN(fromDisplay(values[f.key] ?? "", f.unit));
  const dirty = ADVANCED_FIELDS.some(changed);
  const valid = !ADVANCED_FIELDS.some(invalid);
  const anyRestart = ADVANCED_FIELDS.some((f) => changed(f) && settings.appliesAfterRestart.includes(f.key));

  async function save() {
    if (!dirty || !valid) return;
    const patch: Partial<AdvancedSettings> = {};
    for (const f of ADVANCED_FIELDS) {
      const next = fromDisplay(values[f.key] ?? "", f.unit);
      if (next !== settings.advanced[f.key]) patch[f.key] = next;
    }
    setSaving(true);
    const res = await saveAdvancedSettings(patch);
    setSaving(false);
    if (res.ok) {
      toast.success("Saved.", { description: anyRestart ? "Some changes apply after a restart." : "Applies to new sessions." });
      await onSaved();
    } else {
      toast.error(saveError(res));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {ADVANCED_GROUPS.map((g) => (
        <section key={g.title} aria-label={g.title} className="ui-card flex flex-col gap-4 rounded-[24px] px-6 py-[22px]">
          <div className="flex flex-col gap-0.5">
            <h2 className="t-h2">{g.title}</h2>
            <span className="text-xs text-fg-2">{g.note}</span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(230px,100%),1fr))] gap-3.5">
            {g.fields.map((f) => (
              <UnitField
                key={f.key}
                id={`adv-${f.key}`}
                label={f.title}
                unit={f.unitLabel}
                value={values[f.key] ?? ""}
                onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
                error={invalid(f) ? "Enter a number." : undefined}
                help={`${f.hint}${settings.appliesAfterRestart.includes(f.key) ? " Applies after a restart." : ""}`}
              />
            ))}
          </div>
        </section>
      ))}

      <SaveBar
        dirty={dirty}
        saving={saving}
        status={!dirty ? "Everything is saved." : valid ? "Unsaved changes." : "Fix the marked fields to save."}
        onDiscard={() => setValues(initial)}
        onSave={() => void save()}
      />
    </div>
  );
}

function UnitField({
  id,
  label,
  unit,
  value,
  onChange,
  help,
  error,
}: {
  id: string;
  label: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  help: string;
  error?: string;
}) {
  return (
    <div className="flex flex-col gap-[7px]">
      <label htmlFor={id} className="t-label">
        {label}
      </label>
      <div
        className={cn(
          "flex h-[46px] items-center rounded-[14px] border bg-ground pl-4 pr-1.5 transition-colors focus-within:border-brand-text",
          error ? "border-bad" : "border-line-strong",
        )}
      >
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 min-w-0 flex-1 border-0 bg-transparent font-mono text-[15px] text-fg outline-none"
        />
        <span className="flex-none px-2.5 text-[13px] text-fg-3">{unit}</span>
      </div>
      <span className={cn("text-xs", error ? "text-bad" : "text-fg-3")}>{error ?? help}</span>
    </div>
  );
}
