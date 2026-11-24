"use client";

import * as React from "react";
import { Check, ChevronRight, Eye, EyeOff, Loader2, Plug, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label, FieldHint } from "@/components/ui/label";
import { Select, type SelectOption } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  addProvider,
  updateProvider,
  testProvider,
  probeProvider,
  fetchProviders,
  fetchProfiles,
  routableProviders,
  type ProviderConfigItem,
  type ProfileMetaItem,
} from "@/lib/api";
import {
  PROVIDER_FORM_COPY,
  computePriorityEffect,
  computeWeightEffect,
  slugifyProviderName,
  validateProviderSlug,
  validateProviderUrl,
  validatePositiveInteger,
  validateHeaderRows,
  headersToRecord,
  recordToHeaderRows,
  isProbeableUrl,
  providerProbeCacheKey,
  selectProfileHint,
  type HeaderRow,
  type SiblingProvider,
  type ProviderProbeState,
} from "@shared/provider-form";

interface Props {
  initial: ProviderConfigItem | null;
  siblings: SiblingProvider[];
  availableProfiles: ProfileMetaItem[];
  profilesEnabled: boolean;
  onDone: () => void;
  onCancel: () => void;
}

const COPY = PROVIDER_FORM_COPY;

export function ProviderForm({ initial, siblings, availableProfiles, profilesEnabled, onDone, onCancel }: Props) {
  const isEdit = initial !== null;

  const [name, setName] = React.useState(initial?.id ?? "");
  const [url, setUrl] = React.useState(initial?.url ?? "");
  const [maxConcurrent, setMaxConcurrent] = React.useState(
    initial?.maxConcurrent != null ? String(initial.maxConcurrent) : "",
  );
  const [priority, setPriority] = React.useState<number>(initial?.priority ?? 100);
  const [weight, setWeight] = React.useState<number>(initial?.weight ?? 100);
  const [profile, setProfile] = React.useState<string>(
    initial?.multiProfile ? "" : (initial?.profile ?? ""),
  );
  const [injectProxy, setInjectProxy] = React.useState<boolean>(initial?.injectProxy ?? false);
  const [headers, setHeaders] = React.useState<HeaderRow[]>(() =>
    recordToHeaderRows(initial?.headers),
  );
  const [revealed, setRevealed] = React.useState<Record<string, boolean>>({});
  const [advancedOpen, setAdvancedOpen] = React.useState(headers.length > 0);

  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [probe, setProbe] = React.useState<ProviderProbeState>({ status: "idle" });
  const probeCacheRef = React.useRef<Map<string, ProviderProbeState>>(new Map());
  const [testResult, setTestResult] = React.useState<
    { ok: boolean; latencyMs: number; error?: string } | null
  >(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const otherSiblings = React.useMemo(
    () => (isEdit && initial ? siblings.filter((s) => s.slug !== initial.id) : siblings),
    [siblings, initial, isEdit],
  );

  const outboundHeadersForProbe = React.useMemo(() => headersToRecord(headers), [headers]);

  React.useEffect(() => {
    const trimmed = url.trim();
    if (!isProbeableUrl(trimmed)) {
      queueMicrotask(() => setProbe({ status: "idle" }));
      return;
    }
    const key = providerProbeCacheKey(trimmed, outboundHeadersForProbe);
    const cached = probeCacheRef.current.get(key);
    if (cached) {
      queueMicrotask(() => setProbe(cached));
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setProbe({ status: "probing" });
      probeProvider(trimmed, outboundHeadersForProbe, controller.signal)
        .then((result) => {
          const next: ProviderProbeState = { status: "done", result };
          probeCacheRef.current.set(key, next);
          setProbe(next);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          const next: ProviderProbeState = { status: "unknown" };
          probeCacheRef.current.set(key, next);
          setProbe(next);
          void err;
        });
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url, outboundHeadersForProbe]);

  const priorityEffect = React.useMemo(
    () =>
      computePriorityEffect(priority, [
        ...otherSiblings.map((s) => s.priority),
        priority,
      ]),
    [priority, otherSiblings],
  );

  const weightEffect = React.useMemo(
    () =>
      computeWeightEffect(priority, weight, [
        ...otherSiblings,
        { slug: initial?.id ?? "_this_", priority, weight },
      ]),
    [priority, weight, otherSiblings, initial],
  );

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!isEdit) {
      const slugged = slugifyProviderName(name);
      const err = validateProviderSlug(slugged);
      if (err) errs.name = err;
    }
    const urlErr = validateProviderUrl(url);
    if (urlErr) errs.url = urlErr;
    const mcErr = validatePositiveInteger(maxConcurrent, "Max connections");
    if (mcErr) errs.maxConcurrent = mcErr;
    if (priority < 1) errs.priority = "At least 1.";
    if (weight < 1) errs.weight = "At least 1.";
    const headerErr = validateHeaderRows(headers);
    if (headerErr) errs.headers = headerErr;
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!validate()) return;
    setSaving(true);
    try {
      const payload = {
        url: url.trim(),
        priority,
        weight,
        maxConcurrent: maxConcurrent ? Number(maxConcurrent) : undefined,
        profile: profile.trim() ? profile.trim() : null,
        multiProfile: false,
        injectProxy,
        headers: headersToRecord(headers),
      };
      let result: { ok: boolean; error?: string; details?: string[] };
      if (isEdit && initial) {
        result = await updateProvider(initial.id, payload);
      } else {
        const slug = slugifyProviderName(name);
        result = await addProvider({ id: slug, ...payload });
      }
      if (!result.ok) {
        setSubmitError(result.error ?? result.details?.join("; ") ?? "Save failed.");
        return;
      }
      onDone();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    if (!url.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const outboundHeaders = headersToRecord(headers);
      const r = isEdit && initial
        ? await testProvider(initial.id, undefined, outboundHeaders)
        : await testProvider("_new", url.trim(), outboundHeaders);
      setTestResult(r);
    } catch (err) {
      setTestResult({
        ok: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : COPY.testResult.unknownReason,
      });
    } finally {
      setTesting(false);
    }
  }

  function addHeaderRow() {
    setHeaders((prev) => [
      ...prev,
      { id: `h-${Date.now()}-${prev.length}`, key: "", value: "" },
    ]);
    setErrors((p) => ({ ...p, headers: "" }));
  }

  function updateHeader(id: string, patch: Partial<Omit<HeaderRow, "id">>) {
    setHeaders((prev) => prev.map((h) => (h.id === id ? { ...h, ...patch } : h)));
    setErrors((p) => ({ ...p, headers: "" }));
  }

  function removeHeader(id: string) {
    setHeaders((prev) => prev.filter((h) => h.id !== id));
    setRevealed((prev) => {
      const rest = { ...prev };
      delete rest[id];
      return rest;
    });
  }

  const filledHeaderCount = headers.filter((h) => h.key.trim() && h.value).length;

  const profileOptions: SelectOption<string>[] = React.useMemo(() => {
    const base: SelectOption<string>[] = [
      { value: "", label: COPY.profile.anyOption },
    ];
    if (profile && !availableProfiles.some((p) => p.id === profile)) {
      base.push({ value: profile, label: `Only ${profile} (not created yet)` });
    }
    for (const p of availableProfiles) {
      base.push({ value: p.id, label: `Only ${p.id}` });
    }
    return base;
  }, [availableProfiles, profile]);

  const profileHint = selectProfileHint(profile, probe, COPY.profile);
  const derivedId = !isEdit && name.trim() ? slugifyProviderName(name) : "";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-[18px]">
      {!isEdit && (
        <div>
          <Label htmlFor="prov-name">{COPY.name.label}</Label>
          <Input
            id="prov-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setErrors((p) => ({ ...p, name: "" }));
            }}
            placeholder={COPY.name.placeholder}
            aria-invalid={Boolean(errors.name)}
            autoFocus
            className="font-mono"
          />
          {errors.name ? (
            <p className="mt-[7px] text-xs text-bad">{errors.name}</p>
          ) : (
            <FieldHint>
              {derivedId ? (
                <>
                  ID: <span className="t-mono text-fg">{derivedId}</span>.{" "}
                </>
              ) : null}
              {COPY.name.hint}
            </FieldHint>
          )}
        </div>
      )}

      <div>
        <Label htmlFor="prov-url">{COPY.url.label}</Label>
        <div className="flex gap-2">
          <Input
            id="prov-url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setErrors((p) => ({ ...p, url: "" }));
              setTestResult(null);
            }}
            placeholder={COPY.url.placeholder}
            autoFocus={isEdit}
            aria-invalid={Boolean(errors.url)}
            className="min-w-0 flex-1 font-mono"
          />
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="flex-none"
            onClick={() => void runTest()}
            disabled={testing || !url.trim()}
          >
            {testing ? <Loader2 className="animate-spin" strokeWidth={2} /> : <Plug strokeWidth={2} />}
            {testing ? COPY.actions.testing : COPY.actions.test}
          </Button>
        </div>
        {errors.url ? (
          <p className="mt-[7px] text-xs text-bad">{errors.url}</p>
        ) : (
          <FieldHint>{COPY.url.hint}</FieldHint>
        )}
        {testResult && (
          <div
            className={cn(
              "mt-2 inline-flex items-center gap-1.5 text-xs font-semibold",
              testResult.ok ? "text-good" : "text-bad",
            )}
          >
            {testResult.ok ? (
              <Check className="h-3.5 w-3.5" strokeWidth={2.4} />
            ) : (
              <X className="h-3.5 w-3.5" strokeWidth={2.4} />
            )}
            {testResult.ok
              ? COPY.testResult.ok(testResult.latencyMs)
              : COPY.testResult.fail(testResult.error ?? COPY.testResult.unknownReason)}
          </div>
        )}
      </div>

      {profilesEnabled && (
        <div>
          <Label htmlFor="prov-profile">{COPY.profile.label}</Label>
          <Select
            id="prov-profile"
            label={COPY.profile.label}
            value={profile}
            options={profileOptions}
            onChange={setProfile}
            fullWidth
          />
          <FieldHint>{profileHint}</FieldHint>
        </div>
      )}

      <div className="ui-well flex items-center gap-3.5 px-4 py-3.5">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-bold">{COPY.injectProxy.label}</span>
          <span className="text-xs text-fg-3">{COPY.injectProxy.hint}</span>
        </span>
        <Switch
          label={COPY.injectProxy.label}
          checked={injectProxy}
          onCheckedChange={(next) => setInjectProxy(next)}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <Label htmlFor="prov-max">{COPY.maxConcurrent.label}</Label>
          <Input
            id="prov-max"
            type="number"
            min={1}
            value={maxConcurrent}
            onChange={(e) => {
              setMaxConcurrent(e.target.value);
              setErrors((p) => ({ ...p, maxConcurrent: "" }));
            }}
            placeholder={COPY.maxConcurrent.placeholder}
            aria-invalid={Boolean(errors.maxConcurrent)}
            className="font-mono"
          />
          {errors.maxConcurrent ? (
            <p className="mt-[7px] text-xs text-bad">{errors.maxConcurrent}</p>
          ) : (
            <FieldHint>{COPY.maxConcurrent.hint}</FieldHint>
          )}
        </div>

        <div>
          <Label htmlFor="prov-priority">{COPY.priority.label}</Label>
          <Input
            id="prov-priority"
            type="number"
            min={1}
            value={priority}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 1) setPriority(n);
            }}
            placeholder="100"
            className="font-mono"
          />
          {errors.priority ? (
            <p className="mt-[7px] text-xs text-bad">{errors.priority}</p>
          ) : (
            <FieldHint>
              <span className="text-fg-2">{priorityEffect.label}</span> {COPY.priority.hintStatic}
            </FieldHint>
          )}
        </div>

        <div>
          <Label htmlFor="prov-weight">{COPY.weight.label}</Label>
          <Input
            id="prov-weight"
            type="number"
            min={1}
            value={weight}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 1) setWeight(n);
            }}
            placeholder="100"
            className="font-mono"
          />
          {errors.weight ? (
            <p className="mt-[7px] text-xs text-bad">{errors.weight}</p>
          ) : (
            <FieldHint>
              <span className="text-fg-2">{weightEffect.label}</span> {COPY.weight.hintStatic}
            </FieldHint>
          )}
        </div>
      </div>

      <div className="ui-well overflow-hidden p-0">
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          aria-expanded={advancedOpen}
          className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
        >
          <ChevronRight
            className={cn("h-4 w-4 flex-none text-fg-3 transition-transform", advancedOpen && "rotate-90")}
            strokeWidth={2}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-bold">{COPY.advanced.label}</span>
            <span className="text-xs text-fg-3">
              Custom headers for Bearer, API key or reverse-proxy auth.
              {filledHeaderCount > 0 ? ` ${filledHeaderCount} set.` : ""}
            </span>
          </span>
          <span className="flex-none text-xs text-fg-3">Optional</span>
        </button>

        {advancedOpen && (
          <div className="flex flex-col gap-3 border-t border-line px-4 py-4">
            <div className="flex flex-col gap-1">
              <span className="t-label">{COPY.advanced.headersLabel}</span>
              <p className="t-small">{COPY.advanced.headersHint}</p>
            </div>
            {headers.map((h) => {
              const shown = !!revealed[h.id];
              return (
                <div key={h.id} className="flex flex-wrap items-start gap-2">
                  <Input
                    value={h.key}
                    onChange={(e) => updateHeader(h.id, { key: e.target.value })}
                    placeholder={COPY.advanced.headerNamePlaceholder}
                    aria-label="Header name"
                    className="flex-[1_1_150px] font-mono"
                  />
                  <div className="relative min-w-0 flex-[2_1_220px]">
                    <Input
                      value={h.value}
                      onChange={(e) => updateHeader(h.id, { value: e.target.value })}
                      placeholder={COPY.advanced.headerValuePlaceholder}
                      aria-label="Header value"
                      type={shown ? "text" : "password"}
                      autoComplete="off"
                      spellCheck={false}
                      className="pr-11 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setRevealed((prev) => ({ ...prev, [h.id]: !shown }))}
                      aria-label={shown ? "Hide value" : "Show value"}
                      className="absolute right-2.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-fg-3 hover:text-fg"
                    >
                      {shown ? <EyeOff className="h-4 w-4" strokeWidth={2} /> : <Eye className="h-4 w-4" strokeWidth={2} />}
                    </button>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="w-[46px] px-0"
                    onClick={() => removeHeader(h.id)}
                    aria-label="Remove header"
                  >
                    <X strokeWidth={2} />
                  </Button>
                </div>
              );
            })}
            <button type="button" className="t-link w-fit" onClick={addHeaderRow}>
              + {COPY.advanced.addHeader}
            </button>
            {errors.headers && <p className="text-xs text-bad">{errors.headers}</p>}
          </div>
        )}
      </div>

      {submitError && <Alert title="The provider was not saved">{submitError}</Alert>}

      <div className="ui-dialog__foot">
        <Button type="button" variant="outline" size="lg" onClick={onCancel} disabled={saving}>
          {COPY.actions.cancel}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={saving}
          loadingLabel={isEdit ? COPY.actions.saving : COPY.actions.adding}
        >
          {isEdit ? COPY.actions.saveChanges : COPY.actions.addProvider}
        </Button>
      </div>
    </form>
  );
}

type Loaded =
  | { status: "loading" }
  | { status: "missing" }
  | {
      status: "ready";
      initial: ProviderConfigItem | null;
      siblings: SiblingProvider[];
      profiles: ProfileMetaItem[];
      profilesEnabled: boolean;
    };

interface DialogProps {
  slug: string | null;
  onClose: () => void;
  onSaved: () => void;
}

export function ProviderFormDialog({ slug, onClose, onSaved }: DialogProps) {
  const [state, setState] = React.useState<Loaded>({ status: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchProviders(),
      fetchProfiles().catch(() => ({ enabled: false, count: 0, profiles: [] as ProfileMetaItem[] })),
    ])
      .then(([p, profs]) => {
        if (cancelled) return;
        const match = slug ? p.providers.find((x) => x.id === slug) ?? null : null;
        if (slug && !match) {
          setState({ status: "missing" });
          return;
        }
        setState({
          status: "ready",
          initial: match,
          siblings: routableProviders(p.providers).map((x) => ({
            slug: x.id,
            priority: x.priority,
            weight: x.weight,
          })),
          profiles: profs.profiles,
          profilesEnabled: profs.enabled,
        });
      })
      .catch(() => {
        if (!cancelled) setState(slug ? { status: "missing" } : {
          status: "ready",
          initial: null,
          siblings: [],
          profiles: [],
          profilesEnabled: false,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())} width={680} label={slug ? `Edit ${slug}` : "Add provider"}>
      <DialogHeader
        title={slug ? <>Edit <span className="t-mono">{slug}</span></> : "Add provider"}
        description={
          slug
            ? "Update the connection details for this provider."
            : "Connect any remote browser that speaks the Chrome DevTools Protocol. The gateway picks between providers by priority and availability."
        }
        onClose={onClose}
      />
      {state.status === "loading" ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-[46px] rounded-input" />
          <Skeleton className="h-[46px] rounded-input" />
          <Skeleton className="h-[46px] rounded-input" />
        </div>
      ) : state.status === "missing" ? (
        <Alert title="Provider not found">It was removed from the config. Close this and pick another provider.</Alert>
      ) : (
        <ProviderForm
          key={slug ?? "new"}
          initial={state.initial}
          siblings={state.siblings}
          availableProfiles={state.profiles}
          profilesEnabled={state.profilesEnabled}
          onDone={onSaved}
          onCancel={onClose}
        />
      )}
    </Dialog>
  );
}
