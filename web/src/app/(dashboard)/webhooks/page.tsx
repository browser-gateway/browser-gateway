"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock, Info, Lock, Pencil, PauseCircle, Plus, Power, Send, Webhook as WebhookIcon } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogActions, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RowMenu } from "@/components/ui/row-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  addWebhook,
  deleteWebhook,
  fetchWebhooks,
  testWebhook,
  updateWebhook,
  type WebhookItem,
} from "@/lib/api";

const WEBHOOK_EVENTS: { value: string; label: string; hint: string; icon: typeof Clock; tone: string }[] = [
  {
    value: "provider.cooldown",
    label: "Provider paused",
    hint: "A provider started failing and was put on cooldown.",
    icon: PauseCircle,
    tone: "text-warn",
  },
  {
    value: "queue.timeout",
    label: "Request timed out",
    hint: "A waiting request gave up before a provider was free.",
    icon: Clock,
    tone: "text-fg-soft",
  },
  {
    value: "shutdown.start",
    label: "Gateway shutting down",
    hint: "The gateway began a graceful shutdown.",
    icon: Power,
    tone: "text-fg-soft",
  },
];

const EXAMPLES: Array<{ value: string; label: string; body: string }> = [
  {
    value: "provider.cooldown",
    label: "Provider",
    body: `{
  "version": "1",
  "timestamp": "2026-11-24T09:31:12.000Z",
  "event": "provider.cooldown",
  "status": "firing",
  "source": "browser-gateway",
  "data": {
    "providerId": "<provider id>",
    "cooldownMs": 30000
  }
}`,
  },
  {
    value: "queue.timeout",
    label: "Queue",
    body: `{
  "version": "1",
  "timestamp": "2026-11-24T09:32:40.000Z",
  "event": "queue.timeout",
  "status": "firing",
  "source": "browser-gateway",
  "data": {
    "waitMs": 30000
  }
}`,
  },
  {
    value: "shutdown.start",
    label: "Shutdown",
    body: `{
  "version": "1",
  "timestamp": "2026-11-24T09:40:03.000Z",
  "event": "shutdown.start",
  "status": "firing",
  "source": "browser-gateway",
  "data": {}
}`,
  },
];

const ROW_CHIP = "whitespace-nowrap rounded-[10px] border border-line bg-card px-[9px] py-[3px] font-mono text-xs font-medium text-fg-soft";

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<WebhookItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WebhookItem | null>(null);
  const [deleting, setDeleting] = useState<WebhookItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [example, setExample] = useState(EXAMPLES[0]!.value);

  const refresh = useCallback(async () => {
    try {
      const r = await fetchWebhooks();
      setWebhooks(r.webhooks);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [refresh]);

  function openAdd() {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(w: WebhookItem) {
    setEditing(w);
    setModalOpen(true);
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    const res = await deleteWebhook(deleting.index);
    setDeleteBusy(false);
    if (res.ok) {
      setDeleting(null);
      toast.success("Webhook deleted.");
      await refresh();
    } else {
      toast.error(res.error ?? "Could not delete webhook.");
    }
  }

  const description = "The gateway sends a JSON event to your address when something happens, like a provider going down.";

  if (webhooks === null && !error) {
    return (
      <>
        <PageHeader title="Webhooks" description={description} />
        <div className="flex flex-wrap items-start gap-4">
          <Skeleton className="h-[380px] min-w-0 flex-[3_1_560px] rounded-[28px]" />
          <Skeleton className="h-[380px] min-w-0 flex-[2_1_380px] rounded-[24px]" />
        </div>
      </>
    );
  }

  const eventWells = (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-2.5">
      {WEBHOOK_EVENTS.map(({ value, label, hint, icon: Icon, tone }) => (
        <div key={value} className="flex min-w-0 flex-col gap-1.5 rounded-2xl border border-line bg-ground px-4 py-3.5">
          <span className={tone}>
            <Icon className="size-[18px]" strokeWidth={2} aria-hidden="true" />
          </span>
          <span className="text-sm font-bold">{label}</span>
          <span className="text-xs text-fg-3">{hint}</span>
          <span className="font-mono text-[11px] text-fg-2">{value}</span>
        </div>
      ))}
    </div>
  );

  const list = webhooks ?? [];
  const hero = "ui-card ui-card--hero flex min-w-0 flex-[3_1_560px] flex-col gap-[22px] rounded-[28px] px-7 py-8";
  const shown = EXAMPLES.find((x) => x.value === example) ?? EXAMPLES[0]!;

  return (
    <>
      <PageHeader
        title="Webhooks"
        description={description}
        actions={
          list.length > 0 ? (
            <Button variant="accent" onClick={openAdd}>
              <Plus strokeWidth={2.4} />
              New webhook
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-start gap-4">
        {error && webhooks === null ? (
          <div className="min-w-0 flex-[3_1_560px]">
            <Alert title="The webhooks did not load">
              {error}{" "}
              <button type="button" className="t-link" onClick={() => void refresh()}>
                Retry
              </button>
            </Alert>
          </div>
        ) : list.length === 0 ? (
          <section aria-label="Endpoints" className={hero}>
            <div className="flex max-w-[560px] flex-col items-start gap-2.5">
              <span className="ui-iconcircle size-[52px]">
                <WebhookIcon className="size-[22px]" strokeWidth={2} aria-hidden="true" />
              </span>
              <h2 className="m-0 text-2xl font-bold leading-[1.2] tracking-[-0.02em]">No webhooks yet</h2>
              <span className="text-[15px] text-fg-2">
                Add an address and the gateway posts a JSON event to it when one of these happens. Useful for alerts and your own logs.
              </span>
              <Button variant="primary" className="mt-1 h-11 rounded-[22px] px-5" onClick={openAdd}>
                Add webhook
              </Button>
            </div>
            {eventWells}
          </section>
        ) : (
          <section aria-label="Endpoints" className="ui-card ui-card--hero flex min-w-0 flex-[3_1_560px] flex-col gap-3.5 rounded-[28px] px-6 py-[22px]">
            <h2 className="m-0 text-xl font-bold leading-[1.2] tracking-[-0.02em]">Endpoints</h2>
            {error ? <Alert>{error}</Alert> : null}
            {list.map((w) => (
              <WebhookRow key={w.index} webhook={w} onEdit={() => openEdit(w)} onDelete={() => setDeleting(w)} />
            ))}
            {eventWells}
          </section>
        )}

        <aside aria-label="What arrives" className="ui-card flex min-w-0 flex-[2_1_380px] flex-col gap-3 rounded-[24px] p-[22px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">What arrives</h2>
            <span className="font-mono text-[11px] text-fg-2">{shown.value}</span>
          </div>
          <div role="group" aria-label="Example event" className="flex w-fit max-w-full flex-wrap gap-1 rounded-[22px] border border-line bg-ground p-1">
            {EXAMPLES.map((x) => (
              <button
                key={x.value}
                type="button"
                aria-pressed={example === x.value}
                onClick={() => setExample(x.value)}
                className={cn(
                  "h-9 whitespace-nowrap rounded-[18px] border-0 px-3.5 text-[13px] font-bold",
                  example === x.value ? "bg-fg text-ground" : "bg-transparent text-fg-2 hover:text-fg",
                )}
              >
                {x.label}
              </button>
            ))}
          </div>
          <pre className="ui-code">{shown.body}</pre>
          <div className="flex items-start gap-2.5">
            <Info className="mt-px size-4 flex-none text-brand-text" strokeWidth={2} aria-hidden="true" />
            <span className="text-xs text-fg-2">
              Each event is one POST with a JSON body. The outer fields stay the same and data changes with the event. A failed delivery is
              retried.
            </span>
          </div>
          <div className="flex items-start gap-2.5">
            <Lock className="mt-px size-4 flex-none text-brand-text" strokeWidth={2} aria-hidden="true" />
            <span className="text-xs text-fg-2">
              Each request carries <span className="font-mono">webhook-id</span> and <span className="font-mono">webhook-timestamp</span>{" "}
              headers. Add a <span className="font-mono">secret</span> to the webhook in <span className="font-mono">gateway.yml</span> and it
              also carries <span className="font-mono">webhook-signature</span>, in the Standard Webhooks format.
            </span>
          </div>
        </aside>
      </div>

      <Dialog open={modalOpen} onOpenChange={setModalOpen} width={600} label={editing ? "Edit webhook" : "New webhook"}>
        <WebhookForm
          key={`${editing?.index ?? "new"}-${modalOpen}`}
          initial={editing}
          onClose={() => setModalOpen(false)}
          onSaved={async () => {
            setModalOpen(false);
            toast.success(editing ? "Webhook saved." : "Webhook added.");
            await refresh();
          }}
        />
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)} width={560} label="Delete webhook">
        <DialogHeader
          title="Delete this webhook?"
          description="The gateway stops sending it events."
          onClose={() => setDeleting(null)}
        />
        {deleting ? (
          <span className="ui-well t-mono block px-4 py-3 text-[12.5px] text-[var(--text-code)] [overflow-wrap:anywhere]">{deleting.url}</span>
        ) : null}
        <DialogActions>
          <Button variant="outline" size="lg" onClick={() => setDeleting(null)}>
            Cancel
          </Button>
          <Button variant="destructive" size="lg" onClick={() => void confirmDelete()} loading={deleteBusy}>
            Delete webhook
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function WebhookRow({ webhook: w, onEdit, onDelete }: { webhook: WebhookItem; onEdit: () => void; onDelete: () => void }) {
  const events = w.events ?? [];
  return (
    <article className="flex flex-wrap items-center gap-x-[18px] gap-y-3 rounded-[20px] border border-line bg-ground px-4 py-3.5">
      <div className="flex min-w-0 flex-[2_1_260px] flex-col gap-1.5">
        <span className="truncate font-mono text-[13px] font-medium text-fg" title={w.url}>
          {w.url}
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          {events.length === 0 ? (
            <span className={ROW_CHIP}>All events</span>
          ) : (
            events.map((ev) => (
              <span key={ev} className={ROW_CHIP} title={WEBHOOK_EVENTS.find((x) => x.value === ev)?.label}>
                {ev}
              </span>
            ))
          )}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="outline" className="h-8 rounded-2xl px-3 text-xs" onClick={onEdit}>
          <Pencil className="size-3" strokeWidth={2} />
          Edit
        </Button>
        <RowMenu items={[{ label: "Delete webhook", danger: true, onSelect: onDelete }]} />
      </div>
    </article>
  );
}

function EventCheckRow({
  event,
  checked,
  onToggle,
}: {
  event: (typeof WEBHOOK_EVENTS)[number];
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      className={`flex w-full cursor-pointer items-center gap-3 rounded-2xl border px-3.5 py-3 text-left text-fg transition-colors ${
        checked ? "border-brand-line bg-brand-soft" : "border-line bg-ground hover:border-line-strong"
      }`}
    >
      <span
        aria-hidden="true"
        className={`flex size-5 flex-none items-center justify-center rounded-[6px] border-2 text-xs font-bold leading-none text-ground ${
          checked ? "border-brand-text bg-brand-text" : "border-line-control bg-transparent"
        }`}
      >
        {checked ? "✓" : ""}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="text-sm font-bold">{event.label}</span>
        <span className="text-xs text-fg-3">{event.hint}</span>
      </span>
      <span className="flex-none font-mono text-[11px] text-fg-3 max-[480px]:hidden">{event.value}</span>
    </button>
  );
}

function WebhookForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: WebhookItem | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [url, setUrl] = useState(initial?.url ?? "");
  const [events, setEvents] = useState<string[]>(initial?.events ?? []);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; status?: number; latencyMs: number; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isEdit = initial !== null;
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

  async function handleSubmit() {
    if (!/^https?:\/\//.test(url.trim())) {
      setUrlError("Enter a URL starting with http:// or https://");
      return;
    }
    if (urlIsRedacted) {
      setUrlError("This URL is masked. Retype the full URL to save.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    const data = { url: url.trim(), events: events.length > 0 ? events : undefined };
    const res = isEdit ? await updateWebhook(initial.index, data) : await addWebhook(data);
    setSaving(false);
    if (res.ok) {
      await onSaved();
    } else {
      setSaveError(res.error ?? "Could not save webhook.");
    }
  }

  const help =
    isEdit && urlIsRedacted ? (
      "The saved URL is masked for safety. Retype it to change or test this webhook."
    ) : (
      <>
        The full address that receives the POST. Example: <span className="font-mono">https://your-app.com/hooks/gateway</span>
      </>
    );

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        void handleSubmit();
      }}
    >
      <DialogHeader
        title={isEdit ? "Edit webhook" : "New webhook"}
        description="The gateway POSTs a JSON event to this address. Pick the events to receive, or leave all unticked to receive everything."
        onClose={onClose}
      />
      <Field id="wh-url" label="Endpoint address" help={help} error={urlError}>
        <div className="flex gap-2">
          <Input
            id="wh-url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setUrlError(null);
              setTestResult(null);
            }}
            placeholder="https://your-app.com/hooks/gateway"
            autoFocus
            autoComplete="off"
            className="min-w-0 flex-1 font-mono text-[13px]"
            aria-invalid={!!urlError}
          />
          <Button
            type="button"
            variant="outline"
            className="flex-none"
            onClick={() => void handleTest()}
            disabled={!url.trim() || urlIsRedacted}
            loading={testing}
          >
            <Send strokeWidth={2} />
            Test
          </Button>
        </div>
      </Field>
      {testResult ? (
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={testResult.ok ? "good" : "bad"}>
            {testResult.ok ? `Delivered, HTTP ${testResult.status}` : "Test failed"}
          </StatusBadge>
          <span className="t-small">
            {testResult.ok
              ? `in ${testResult.latencyMs}ms`
              : (testResult.error ?? `HTTP ${testResult.status}`)}
          </span>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <span className="t-label">Events</span>
        {WEBHOOK_EVENTS.map((ev) => (
          <EventCheckRow key={ev.value} event={ev} checked={events.includes(ev.value)} onToggle={() => toggleEvent(ev.value)} />
        ))}
        <span className="text-xs text-fg-3">Leave all unticked to receive every event.</span>
      </div>

      {saveError ? <Alert>{saveError}</Alert> : null}

      <DialogActions>
        <Button type="button" variant="outline" size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="lg" loading={saving}>
          {isEdit ? "Save changes" : "Add webhook"} ·{" "}
          {events.length === 0 ? "all events" : `${events.length} event${events.length === 1 ? "" : "s"}`}
        </Button>
      </DialogActions>
    </form>
  );
}
