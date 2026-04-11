"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, Pencil, Trash2, Zap, Check, X, Loader2, Server, ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  addProvider,
  updateProvider,
  deleteProvider,
  testProvider,
  type GatewayStatus,
  type ProviderConfigItem,
} from "@/lib/api";

interface TestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export default function ProvidersPage() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [providers, setProviders] = useState<ProviderConfigItem[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderConfigItem | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([fetchStatus(), fetchProviders()]);
      setStatus(s);
      setProviders(p.providers);
      setError(null);
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

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
          <Button size="sm" onClick={openAdd} className="h-8 text-xs gap-1.5 shrink-0">
            <Plus className="h-3.5 w-3.5" />
            Add Provider
          </Button>
        )}
      </div>

      {error && (
        <Card className="border-destructive/50">
          <CardContent className="px-4 py-3 flex items-center justify-between">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="ghost" size="sm" onClick={() => setError(null)} className="h-6 w-6 p-0">
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
                  <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 mt-1.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium">Playwright Server</p>
                    <p className="text-xs text-muted-foreground">Self-hosted via <span className="font-mono">npx playwright run-server</span></p>
                    <p className="text-xs text-muted-foreground/70 font-mono mt-1">ws://your-server:3000</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30">
                  <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 mt-1.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium">Cloud Browser Service</p>
                    <p className="text-xs text-muted-foreground">Any cloud provider that gives you a WebSocket URL with an API key</p>
                    <p className="text-xs text-muted-foreground/70 font-mono mt-1">wss://provider.com?token=your-api-key</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30">
                  <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 mt-1.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium">Chrome Remote Debugging</p>
                    <p className="text-xs text-muted-foreground">Chrome launched with <span className="font-mono">--remote-debugging-port</span></p>
                    <p className="text-xs text-muted-foreground/70 font-mono mt-1">http://192.168.1.100:9222</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-center">
              <Button size="sm" className="h-9 text-sm gap-2" onClick={openAdd}>
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
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex items-center gap-2.5">
                      <div className={`h-2 w-2 rounded-full shrink-0 ${live?.healthy !== false ? "bg-emerald-500" : "bg-red-500 animate-pulse"}`} />
                      <span className="text-sm font-semibold font-mono truncate">{provider.id}</span>
                      <Badge variant="secondary" className="text-[10px] h-5 px-1.5 font-normal shrink-0">
                        Priority {provider.priority}
                      </Badge>
                      {live?.cooldownUntil && (
                        <Badge variant="destructive" className="text-[10px] h-5 px-1.5 shrink-0">cooldown</Badge>
                      )}
                    </div>

                    <p className="text-xs text-muted-foreground font-mono truncate">{provider.url}</p>

                    <div className="flex items-center gap-5 text-xs text-muted-foreground flex-wrap">
                      <span>
                        Max connections: <span className="text-foreground font-mono">{provider.maxConcurrent ?? "unlimited"}</span>
                      </span>
                      {provider.weight > 1 && (
                        <span>
                          Weight: <span className="text-foreground font-mono">{provider.weight}</span>
                        </span>
                      )}
                      {live && (
                        <>
                          <span>
                            Active: <span className="text-foreground font-mono">{live.active}</span>
                          </span>
                          <span>
                            Avg latency: <span className="text-foreground font-mono">{live.avgLatencyMs}ms</span>
                          </span>
                          <span>
                            Total routed: <span className="text-foreground font-mono">{live.totalConnections}</span>
                          </span>
                        </>
                      )}
                    </div>

                    {test && (
                      <div className={`flex items-center gap-1.5 text-xs ${test.ok ? "text-emerald-500" : "text-destructive"}`}>
                        {test.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                        {test.ok ? `Connected successfully in ${test.latencyMs}ms` : `Connection failed: ${test.error}`}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => handleTest(provider.id)} disabled={testingId === provider.id} title="Test connection">
                      {testingId === provider.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => openEdit(provider)} title="Edit provider">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:text-destructive" onClick={() => handleDelete(provider.id)} title="Remove provider">
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
            onSave={async (data) => {
              if (editingProvider) {
                const result = await updateProvider(editingProvider.id, data);
                if (result.ok) { setModalOpen(false); await refresh(); }
                else setError(result.error ?? "Failed to update");
              } else {
                const result = await addProvider(data as { id: string; url: string; maxConcurrent?: number; priority?: number; weight?: number });
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
  onSave,
  onCancel,
  onTest,
}: {
  initial?: ProviderConfigItem | null;
  onSave: (data: { id?: string; url: string; maxConcurrent?: number; priority?: number; weight?: number }) => Promise<void>;
  onCancel: () => void;
  onTest: (url: string) => Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [maxConcurrent, setMaxConcurrent] = useState(initial?.maxConcurrent?.toString() ?? "");
  const [priority, setPriority] = useState(initial?.priority?.toString() ?? "1");
  const [weight, setWeight] = useState(initial?.weight?.toString() ?? "1");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs: number; error?: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const isEdit = !!initial;

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!isEdit && !id.trim()) errs.id = "Give this provider a name";
    else if (!isEdit && !/^[a-zA-Z0-9_-]+$/.test(id)) errs.id = "Only letters, numbers, hyphens, and underscores";
    if (!url.trim()) errs.url = "Enter the WebSocket URL for this provider";
    else if (!url.startsWith("ws://") && !url.startsWith("wss://")) errs.url = "URL must start with ws:// (local) or wss:// (secure/cloud)";
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
    await onSave({
      ...(isEdit ? {} : { id: id.trim() }),
      url: url.trim(),
      maxConcurrent: maxConcurrent ? Number(maxConcurrent) : undefined,
      priority: priority ? Number(priority) : undefined,
      weight: weight ? Number(weight) : undefined,
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
        <label className="text-sm font-medium block mb-1.5">WebSocket URL</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setErrors((p) => ({ ...p, url: "" })); setTestResult(null); }}
            placeholder="ws://your-server:3000 or wss://provider.com?token=xxx"
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
          <p className={`text-xs mt-1.5 ${testResult.ok ? "text-emerald-500" : "text-destructive"}`}>
            {testResult.ok ? `Connected successfully in ${testResult.latencyMs}ms` : `Connection failed: ${testResult.error}`}
          </p>
        )}
        <p className="text-xs text-muted-foreground mt-1.5">
          The WebSocket endpoint of your browser service. Use <span className="font-mono text-foreground/70">ws://</span> for local servers and <span className="font-mono text-foreground/70">wss://</span> for cloud services.
          If your provider requires an API key, include it in the URL (e.g. <span className="font-mono text-foreground/70">?token=your-key</span>).
        </p>
      </div>

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
