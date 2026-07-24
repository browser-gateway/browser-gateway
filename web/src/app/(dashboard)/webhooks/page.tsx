"use client";

import { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Zap, Check, X, Loader2, Webhook } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  fetchWebhooks,
  addWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhook,
  type WebhookItem,
} from "@/lib/api";

const WEBHOOK_EVENTS: { value: string; label: string; hint: string }[] = [
  { value: "provider.cooldown", label: "Provider paused", hint: "A provider started failing and was put on cooldown." },
  { value: "queue.timeout", label: "Request timed out", hint: "A waiting request gave up before a provider was free." },
  { value: "shutdown.start", label: "Gateway shutting down", hint: "The gateway began a graceful shutdown." },
];

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<WebhookItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WebhookItem | null>(null);

  async function refresh() {
    try {
      const r = await fetchWebhooks();
      setWebhooks(r.webhooks);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function openAdd() {
    setEditing(null);
    setModalOpen(true);
  }
  function openEdit(w: WebhookItem) {
    setEditing(w);
    setModalOpen(true);
  }

  async function handleDelete(index: number) {
    if (!confirm("Delete this webhook? The gateway will stop sending it events.")) return;
    const res = await deleteWebhook(index);
    if (res.ok) await refresh();
    else setError(res.error ?? "Could not delete webhook");
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Webhooks</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Get an HTTP notification when something happens, like a provider going down. The gateway POSTs a JSON payload to each URL.
          </p>
        </div>
        {webhooks && webhooks.length > 0 && (
          <Button size="sm" onClick={openAdd} className="gap-1.5 shrink-0">
            <Plus className="h-3.5 w-3.5" />
            Add Webhook
          </Button>
        )}
      </div>

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

      {webhooks && webhooks.length === 0 && (
        <Card className="glass">
          <CardContent className="p-8 flex flex-col items-center text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
              <Webhook className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
            </div>
            <p className="text-lg font-medium">No webhooks yet</p>
            <p className="text-sm text-muted-foreground mt-1.5 max-w-lg">
              Add a URL and the gateway will POST a JSON event to it when a provider is paused, a request times out, or the gateway shuts down.
            </p>
            <Button size="sm" onClick={openAdd} className="gap-1.5 mt-5">
              <Plus className="h-3.5 w-3.5" />
              Add Webhook
            </Button>
          </CardContent>
        </Card>
      )}

      {webhooks && webhooks.length > 0 && (
        <div className="space-y-3">
          {webhooks.map((w) => (
            <Card key={w.index} className="glass">
              <CardContent className="px-5 py-4 flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-1.5">
                  <p className="text-sm font-mono text-foreground truncate">{w.url}</p>
                  <p className="text-xs text-muted-foreground">
                    {w.events === null || w.events.length === 0
                      ? "Receives all events"
                      : `Receives: ${w.events
                          .map((e) => WEBHOOK_EVENTS.find((x) => x.value === e)?.label ?? e)
                          .join(", ")}`}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="icon-sm" onClick={() => openEdit(w)} title="Edit webhook">
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" onClick={() => handleDelete(w.index)} title="Delete webhook">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!webhooks && !error && (
        <Card><CardContent className="p-6 text-sm text-muted-foreground">Loading...</CardContent></Card>
      )}

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit webhook" : "Add a webhook"}</DialogTitle>
            <DialogDescription>
              The gateway POSTs a JSON event to this URL. Choose which events to receive, or leave all unchecked to receive everything.
            </DialogDescription>
          </DialogHeader>
          <WebhookForm
            initial={editing}
            onSaved={async () => { setModalOpen(false); await refresh(); }}
            onError={setError}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WebhookForm({
  initial,
  onSaved,
  onError,
}: {
  initial: WebhookItem | null;
  onSaved: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [url, setUrl] = useState(initial?.url ?? "");
  const [events, setEvents] = useState<string[]>(initial?.events ?? []);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; status?: number; latencyMs: number; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  const isEdit = initial !== null;
  // A redacted URL (contains ***) can't be re-saved as-is.
  const urlIsRedacted = url.includes("***");

  function toggleEvent(value: string) {
    setEvents((prev) => (prev.includes(value) ? prev.filter((e) => e !== value) : [...prev, value]));
  }

  async function handleTest() {
    if (!url.trim()) return;
    setTesting(true);
    setTestResult(null);
    setTestResult(await testWebhook(url.trim()));
    setTesting(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^https?:\/\//.test(url.trim())) {
      setUrlError("Enter a URL starting with http:// or https://");
      return;
    }
    if (urlIsRedacted) {
      setUrlError("This URL is masked. Retype the full URL to save.");
      return;
    }
    setSaving(true);
    const data = { url: url.trim(), events: events.length > 0 ? events : undefined };
    const res = isEdit ? await updateWebhook(initial.index, data) : await addWebhook(data);
    setSaving(false);
    if (res.ok) {
      await onSaved();
    } else {
      onError(res.error ?? "Could not save webhook");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className="text-sm font-medium block mb-1.5">URL</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setUrlError(null); setTestResult(null); }}
            placeholder="https://your-app.com/hooks/gateway"
            autoFocus
            className="flex-1 h-9 px-3 text-sm rounded-md border border-input bg-background font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button type="button" variant="secondary" size="sm" className="h-9 text-xs gap-1.5 shrink-0" onClick={handleTest} disabled={testing || !url.trim() || urlIsRedacted}>
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            Test
          </Button>
        </div>
        {urlError && <p className="text-xs text-destructive mt-1">{urlError}</p>}
        {testResult && (
          <p className={`text-xs mt-1.5 ${testResult.ok ? "text-foreground" : "text-destructive"}`}>
            {testResult.ok
              ? `Test delivered (HTTP ${testResult.status}) in ${testResult.latencyMs}ms`
              : `Test failed: ${testResult.error ?? `HTTP ${testResult.status}`}`}
          </p>
        )}
        {isEdit && urlIsRedacted && (
          <p className="text-xs text-muted-foreground mt-1.5">The saved URL is masked for safety. Retype it to change or test this webhook.</p>
        )}
      </div>

      <div>
        <label className="text-sm font-medium block mb-2">Events</label>
        <div className="space-y-2">
          {WEBHOOK_EVENTS.map((ev) => (
            <label key={ev.value} className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={events.includes(ev.value)}
                onChange={() => toggleEvent(ev.value)}
                className="mt-0.5 size-4 rounded border-input accent-foreground"
              />
              <span className="text-sm">
                <span className="text-foreground">{ev.label}</span>
                <span className="block text-xs text-muted-foreground">{ev.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-2">Leave all unchecked to receive every event.</p>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="submit" size="sm" disabled={saving} className="gap-1.5">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          {isEdit ? "Save changes" : "Add webhook"}
        </Button>
      </div>
    </form>
  );
}
