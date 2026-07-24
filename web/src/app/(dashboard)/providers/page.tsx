"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, Pencil, Trash2, Zap, Check, X, Loader2, Server } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CapabilityStrip } from "@/components/capability-strip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  fetchStatus,
  fetchProviders,
  fetchProfiles,
  addProvider,
  updateProvider,
  deleteProvider,
  testProvider,
  setStrategy,
  type GatewayStatus,
  type ProviderConfigItem,
  type ProfileMetaItem,
  type Strategy,
} from "@/lib/api";

const STRATEGY_OPTIONS: { value: Strategy; label: string; hint: string }[] = [
  { value: "priority-chain", label: "Priority chain", hint: "Always use the highest-priority provider that has room." },
  { value: "round-robin", label: "Round robin", hint: "Spread sessions evenly across providers." },
  { value: "least-connections", label: "Least busy", hint: "Send to whichever provider has the fewest active sessions." },
  { value: "latency-optimized", label: "Fastest", hint: "Prefer the provider with the lowest recent latency." },
  { value: "weighted", label: "Weighted", hint: "Split traffic by each provider's weight." },
];

interface TestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export default function ProvidersPage() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [providers, setProviders] = useState<ProviderConfigItem[]>([]);
  const [availableProfiles, setAvailableProfiles] = useState<ProfileMetaItem[]>([]);
  const [profilesEnabled, setProfilesEnabled] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderConfigItem | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingStrategy, setSavingStrategy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, p, profs] = await Promise.all([fetchStatus(), fetchProviders(), fetchProfiles()]);
      setStatus(s);
      setProviders(p.providers);
      setAvailableProfiles(profs.profiles);
      setProfilesEnabled(profs.enabled);
      setError(null);
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleStrategyChange = async (next: Strategy) => {
    setSavingStrategy(true);
    const res = await setStrategy(next);
    setSavingStrategy(false);
    if (res.ok) await refresh();
    else setError(res.error ?? "Could not change routing strategy");
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const result = await testProvider(id);
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch {
      setTestResults((prev) => ({ ...prev, [id]: { ok: false, latencyMs: 0, error: "Failed" } }));
    }
    setTestingId(null);
  };

  const handleDelete = async (id: string) => {
    const result = await deleteProvider(id);
    if (result.ok) await refresh();
    else setError(result.error ?? "Failed to delete");
  };

  const openAdd = () => { setEditingProvider(null); setModalOpen(true); };
  const openEdit = (p: ProviderConfigItem) => { setEditingProvider(p); setModalOpen(true); };

  const statusMap = status
    ? Object.fromEntries(status.providers.map((p) => [p.id, p]))
    : {};

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Providers</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Remote browser services that the gateway routes connections to. Each provider is a WebSocket endpoint running a headless browser.
          </p>
        </div>
        {providers.length > 0 && (
          <Button size="sm" onClick={openAdd} className="gap-1.5 shrink-0">
            <Plus className="h-3.5 w-3.5" />
            Add Provider
          </Button>
        )}
      </div>

      {providers.length > 0 && status && (
        <Card className="glass">
          <CardContent className="px-5 py-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-xs font-medium text-foreground">Routing</span>
            <select
              value={status.strategy}
              onChange={(e) => handleStrategyChange(e.target.value as Strategy)}
              disabled={savingStrategy}
              className="h-8 px-2 text-xs rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            >
              {STRATEGY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">
              {STRATEGY_OPTIONS.find((o) => o.value === status.strategy)?.hint ?? "How the gateway picks which provider handles each session."}
            </span>
          </CardContent>
        </Card>
      )}

      {error && (
        <Card className="border-destructive/50">
          <CardContent className="px-4 py-3 flex items-center justify-between">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="ghost" size="icon-xs" onClick={() => setError(null)}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </CardContent>
        </Card>
      )}

      {providers.length === 0 && (
        <Card className="glass">
          <CardContent className="p-8 space-y-6">
            <div className="flex flex-col items-center text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
                <Server className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
              </div>
              <p className="text-lg font-medium">Add your first browser provider</p>
              <p className="text-sm text-muted-foreground mt-1.5 max-w-lg">
                A provider is a remote browser service that you want the gateway to route connections to.
                This could be a self-hosted Playwright server, a cloud browser service, or a raw Chrome instance with remote debugging enabled.
              </p>
            </div>

            <div className="max-w-lg mx-auto space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Common provider types</p>
              <div className="grid gap-2">
                <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30">
                  <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground mt-1.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium">Playwright Server</p>
                    <p className="text-xs text-muted-foreground">Self-hosted via <span className="font-mono">npx playwright run-server</span></p>
                    <p className="text-xs text-muted-foreground/70 font-mono mt-1">ws://your-server:3000</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30">
                  <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground mt-1.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium">Cloud Browser Service</p>
                    <p className="text-xs text-muted-foreground">Any cloud provider that gives you a WebSocket URL with an API key</p>
                    <p className="text-xs text-muted-foreground/70 font-mono mt-1">wss://provider.com?token=your-api-key</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30">
                  <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground mt-1.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium">Chrome Remote Debugging</p>
                    <p className="text-xs text-muted-foreground">Chrome launched with <span className="font-mono">--remote-debugging-port</span></p>
                    <p className="text-xs text-muted-foreground/70 font-mono mt-1">http://your-host:9222</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-center">
              <Button onClick={openAdd} className="gap-2">
                <Plus className="h-4 w-4" />
                Add Provider
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {providers.map((provider) => {
          const live = statusMap[provider.id];
          const test = testResults[provider.id];

          return (
            <Card key={provider.id} className="glass">
              <CardContent className="px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0 space-y-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className={`h-2 w-2 rounded-full shrink-0 ${
                        live?.cooldownUntil || live?.healthy === false
                          ? "bg-destructive animate-pulse"
                          : live
                          ? "bg-foreground"
                          : "bg-muted-foreground/40"
                      }`} />
                      <span className="text-sm font-semibold font-mono truncate">{provider.id}</span>
                      <span className="text-[11px] text-muted-foreground shrink-0">
                        {live?.cooldownUntil
                          ? "Paused"
                          : live?.healthy === false
                          ? "Not reachable"
                          : live
                          ? "Ready"
                          : "Checking…"}
                      </span>
                    </div>

                    <p className="text-xs text-muted-foreground font-mono truncate">{provider.url}</p>

                    <dl className="grid grid-cols-[5.5rem_1fr] gap-x-4 gap-y-1.5 text-xs">
                      <dt className="text-muted-foreground">Type</dt>
                      <dd className="text-foreground">
                        {provider.detectedKind === "browserserve" ? "Self-hosted browserserve" : "External browser service"}
                      </dd>

                      <dt className="text-muted-foreground">Priority</dt>
                      <dd className="text-foreground">
                        {provider.priority}
                        <span className="text-muted-foreground"> · {provider.priority === 1 ? "tried first" : "used as fallback"}</span>
                      </dd>

                      <dt className="text-muted-foreground">Serves</dt>
                      <dd className="text-foreground">
                        {provider.multiProfile ? (
                          "Any profile"
                        ) : provider.profile ? (
                          <>Only the <span className="font-mono">{provider.profile}</span> profile</>
                        ) : (
                          "Sessions with no profile"
                        )}
                      </dd>

                      <dt className="text-muted-foreground">Capacity</dt>
                      <dd className="text-foreground">
                        {live?.active ?? 0} in use / {provider.maxConcurrent ?? "no limit"}
                        {provider.maxConcurrentSource === "discovered" && <span className="text-muted-foreground"> · set automatically</span>}
                        {provider.weight > 1 && <span className="text-muted-foreground"> · weight {provider.weight}</span>}
                      </dd>

                      {live && live.totalConnections > 0 && (
                        <>
                          <dt className="text-muted-foreground">Traffic</dt>
                          <dd className="text-foreground">{live.totalConnections} sent here · {live.avgLatencyMs}ms average</dd>
                        </>
                      )}
                    </dl>

                    {live?.cooldownUntil && (
                      <p className="text-xs text-destructive">
                        Paused after repeated failures. It will be retried automatically.
                      </p>
                    )}

                    {test && (
                      <div className={`flex items-center gap-1.5 text-xs ${test.ok ? "text-foreground" : "text-destructive"}`}>
                        {test.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                        {test.ok ? `Connected in ${test.latencyMs}ms` : `Could not connect: ${test.error}`}
                      </div>
                    )}

                    <div className="space-y-1.5 pt-0.5">
                      <div className="text-[11px] text-muted-foreground">Supports</div>
                      <CapabilityStrip providerId={provider.id} />
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon-sm" onClick={() => handleTest(provider.id)} disabled={testingId === provider.id} title="Test connection">
                      {testingId === provider.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => openEdit(provider)} title="Edit provider">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" onClick={() => handleDelete(provider.id)} title="Remove provider">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingProvider ? `Edit ${editingProvider.id}` : "Add a Browser Provider"}</DialogTitle>
            <DialogDescription>
              {editingProvider
                ? "Update the connection details for this provider."
                : "Connect a remote browser service. The gateway will route WebSocket connections to this provider based on priority and availability."
              }
            </DialogDescription>
          </DialogHeader>
          <ProviderForm
            initial={editingProvider}
            availableProfiles={availableProfiles}
            profilesEnabled={profilesEnabled}
            onSave={async (data) => {
              if (editingProvider) {
                const result = await updateProvider(editingProvider.id, data);
                if (result.ok) { setModalOpen(false); await refresh(); }
                else setError(result.error ?? "Failed to update");
              } else {
                const result = await addProvider(data as { id: string; url: string; maxConcurrent?: number; priority?: number; weight?: number; profile?: string | null; multiProfile?: boolean });
                if (result.ok) { setModalOpen(false); await refresh(); }
                else setError(result.error ?? "Failed to add");
              }
            }}
            onCancel={() => setModalOpen(false)}
            onTest={async (url) => testProvider(editingProvider?.id ?? "_new", url)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProviderForm({
  initial,
  availableProfiles,
  profilesEnabled,
  onSave,
  onCancel,
  onTest,
}: {
  initial?: ProviderConfigItem | null;
  availableProfiles: ProfileMetaItem[];
  profilesEnabled: boolean;
  onSave: (data: { id?: string; url: string; maxConcurrent?: number; priority?: number; weight?: number; profile?: string | null; multiProfile?: boolean }) => Promise<void>;
  onCancel: () => void;
  onTest: (url: string) => Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [maxConcurrent, setMaxConcurrent] = useState(initial?.maxConcurrent?.toString() ?? "");
  const [priority, setPriority] = useState(initial?.priority?.toString() ?? "1");
  const [weight, setWeight] = useState(initial?.weight?.toString() ?? "1");
  const [profile, setProfile] = useState(initial?.multiProfile ? "*" : (initial?.profile ?? ""));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs: number; error?: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const isEdit = !!initial;

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!isEdit && !id.trim()) errs.id = "Give this provider a name";
    else if (!isEdit && !/^[a-zA-Z0-9_-]+$/.test(id)) errs.id = "Only letters, numbers, hyphens, and underscores";
    if (!url.trim()) errs.url = "Enter the URL for this provider";
    else if (!/^(ws|wss|http|https):\/\//.test(url)) errs.url = "URL must start with ws://, wss://, http://, or https://";
    if (maxConcurrent && (isNaN(Number(maxConcurrent)) || Number(maxConcurrent) < 1)) errs.maxConcurrent = "Must be a positive number";
    if (priority && (isNaN(Number(priority)) || Number(priority) < 1)) errs.priority = "Must be a positive number";
    if (weight && (isNaN(Number(weight)) || Number(weight) < 1)) errs.weight = "Must be a positive number";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setSaving(true);
    const servesAll = profile === "*";
    await onSave({
      ...(isEdit ? {} : { id: id.trim() }),
      url: url.trim(),
      maxConcurrent: maxConcurrent ? Number(maxConcurrent) : undefined,
      priority: priority ? Number(priority) : undefined,
      weight: weight ? Number(weight) : undefined,
      profile: servesAll ? null : (profile.trim() ? profile.trim() : null),
      multiProfile: servesAll,
    });
    setSaving(false);
  };

  const handleTest = async () => {
    if (!url.trim()) return;
    setTesting(true);
    setTestResult(null);
    setTestResult(await onTest(url.trim()));
    setTesting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {!isEdit && (
        <div>
          <label className="text-sm font-medium block mb-1.5">Provider Name</label>
          <input
            type="text"
            value={id}
            onChange={(e) => { setId(e.target.value); setErrors((p) => ({ ...p, id: "" })); }}
            placeholder="e.g. my-playwright, cloud-provider, office-chrome"
            autoFocus
            className="w-full h-9 px-3 text-sm rounded-md border border-input bg-background font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {errors.id && <p className="text-xs text-destructive mt-1">{errors.id}</p>}
          <p className="text-xs text-muted-foreground mt-1.5">
            A unique name to identify this provider in the dashboard and config. Use lowercase with hyphens.
          </p>
        </div>
      )}

      <div>
        <label className="text-sm font-medium block mb-1.5">Provider URL</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setErrors((p) => ({ ...p, url: "" })); setTestResult(null); }}
            placeholder="wss://provider.com?token=xxx or http://localhost:9222"
            autoFocus={isEdit}
            className="flex-1 h-9 px-3 text-sm rounded-md border border-input bg-background font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button type="button" variant="secondary" size="sm" className="h-9 text-xs gap-1.5 shrink-0" onClick={handleTest} disabled={testing || !url.trim()}>
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            Test
          </Button>
        </div>
        {errors.url && <p className="text-xs text-destructive mt-1">{errors.url}</p>}
        {testResult && (
          <p className={`text-xs mt-1.5 ${testResult.ok ? "text-foreground" : "text-destructive"}`}>
            {testResult.ok ? `Connected successfully in ${testResult.latencyMs}ms` : `Connection failed: ${testResult.error}`}
          </p>
        )}
        <p className="text-xs text-muted-foreground mt-1.5">
          <span className="font-mono text-foreground/70">wss://</span> for cloud services, <span className="font-mono text-foreground/70">ws://</span> for local WebSocket servers, or <span className="font-mono text-foreground/70">http://</span> for Chrome remote debugging (the WebSocket URL is auto-discovered from <span className="font-mono text-foreground/70">/json/version</span>).
          If your provider requires an API key, include it in the URL (e.g. <span className="font-mono text-foreground/70">?token=your-key</span>).
        </p>
      </div>

      {profilesEnabled && (
        <div>
          <label className="text-sm font-medium block mb-1.5">Which profiles it serves</label>
          <select
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            className="w-full h-9 px-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">Sessions with no profile</option>
            <option value="*">Any profile</option>
            {profile && profile !== "*" && !availableProfiles.some((p) => p.id === profile) && (
              <option value={profile}>Only {profile} (not created yet)</option>
            )}
            {availableProfiles.map((p) => (
              <option key={p.id} value={p.id}>Only {p.id}</option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground mt-1.5">
            {profile === "*" ? (
              <>Loads any profile a client asks for. Best for providers that start a fresh browser each session, like browserserve. Detected browserserve providers do this automatically.</>
            ) : profile ? (
              <>Only sessions that connect with <span className="font-mono text-foreground/70">?profile={profile}</span> are sent here.</>
            ) : (
              <>Only sessions with no <span className="font-mono text-foreground/70">?profile=</span> are sent here. Pick a profile to dedicate this provider to it.</>
            )}
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="text-sm font-medium block mb-1.5">Max Connections</label>
          <input
            type="number"
            value={maxConcurrent}
            onChange={(e) => { setMaxConcurrent(e.target.value); setErrors((p) => ({ ...p, maxConcurrent: "" })); }}
            placeholder="No limit"
            min="1"
            className="w-full h-9 px-3 text-sm rounded-md border border-input bg-background font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {errors.maxConcurrent && <p className="text-xs text-destructive mt-1">{errors.maxConcurrent}</p>}
          <p className="text-xs text-muted-foreground mt-1.5">
            Max simultaneous sessions. Leave empty for no limit.
          </p>
        </div>

        <div>
          <label className="text-sm font-medium block mb-1.5">Priority</label>
          <input
            type="number"
            value={priority}
            onChange={(e) => { setPriority(e.target.value); setErrors((p) => ({ ...p, priority: "" })); }}
            placeholder="1"
            min="1"
            className="w-full h-9 px-3 text-sm rounded-md border border-input bg-background font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {errors.priority && <p className="text-xs text-destructive mt-1">{errors.priority}</p>}
          <p className="text-xs text-muted-foreground mt-1.5">
            Lower = tried first. 1 for primary, 2 for fallback.
          </p>
        </div>

        <div>
          <label className="text-sm font-medium block mb-1.5">Weight</label>
          <input
            type="number"
            value={weight}
            onChange={(e) => { setWeight(e.target.value); setErrors((p) => ({ ...p, weight: "" })); }}
            placeholder="1"
            min="1"
            className="w-full h-9 px-3 text-sm rounded-md border border-input bg-background font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {errors.weight && <p className="text-xs text-destructive mt-1">{errors.weight}</p>}
          <p className="text-xs text-muted-foreground mt-1.5">
            For weighted strategy. Higher = more traffic. Default: 1.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" size="sm" className="h-9 text-sm" disabled={saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
          {isEdit ? "Save Changes" : "Add Provider"}
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-9 text-sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
