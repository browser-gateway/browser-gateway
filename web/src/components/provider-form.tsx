"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  X,
  Zap,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, type SelectOption } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  addProvider,
  updateProvider,
  testProvider,
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
  type HeaderRow,
  type SiblingProvider,
} from "@shared/provider-form";

interface Props {
  initial: ProviderConfigItem | null;
  siblings: SiblingProvider[];
  availableProfiles: ProfileMetaItem[];
  profilesEnabled: boolean;
}

const COPY = PROVIDER_FORM_COPY;

export function ProviderForm({ initial, siblings, availableProfiles, profilesEnabled }: Props) {
  const router = useRouter();
  const isEdit = initial !== null;

  const [name, setName] = React.useState(initial?.id ?? "");
  const [url, setUrl] = React.useState(initial?.url ?? "");
  const [maxConcurrent, setMaxConcurrent] = React.useState(
    initial?.maxConcurrent != null ? String(initial.maxConcurrent) : "",
  );
  const [priority, setPriority] = React.useState<number>(initial?.priority ?? 100);
  const [weight, setWeight] = React.useState<number>(initial?.weight ?? 100);
  const [profile, setProfile] = React.useState<string>(
    initial?.multiProfile ? "*" : (initial?.profile ?? ""),
  );
  const [headers, setHeaders] = React.useState<HeaderRow[]>(() =>
    recordToHeaderRows(initial?.headers),
  );
  const [revealed, setRevealed] = React.useState<Record<string, boolean>>({});
  const [advancedOpen, setAdvancedOpen] = React.useState(headers.length > 0);

  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<
    { ok: boolean; latencyMs: number; error?: string } | null
  >(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const otherSiblings = React.useMemo(
    () => (isEdit && initial ? siblings.filter((s) => s.slug !== initial.id) : siblings),
    [siblings, initial, isEdit],
  );

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
      const servesAll = profile === "*";
      const payload = {
        url: url.trim(),
        priority,
        weight,
        maxConcurrent: maxConcurrent ? Number(maxConcurrent) : undefined,
        profile: servesAll ? null : (profile.trim() ? profile.trim() : null),
        multiProfile: servesAll,
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
      router.push("/providers");
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
      const r = isEdit && initial
        ? await testProvider(initial.id)
        : await testProvider("_new", url.trim());
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
      { value: "", label: COPY.profile.noneOption },
      { value: "*", label: COPY.profile.anyOption },
    ];
    if (profile && profile !== "*" && !availableProfiles.some((p) => p.id === profile)) {
      base.push({ value: profile, label: `Only ${profile} (not created yet)` });
    }
    for (const p of availableProfiles) {
      base.push({ value: p.id, label: `Only ${p.id}` });
    }
    return base;
  }, [availableProfiles, profile]);

  const profileHint =
    profile === "*"
      ? COPY.profile.hintAny
      : profile
      ? COPY.profile.hintPinned(profile)
      : COPY.profile.hintNone;

  return (
    <form onSubmit={handleSubmit}>
      <Card>
        <CardContent className="p-6 space-y-5">
          {!isEdit && (
            <div>
              <label className="text-sm font-medium block mb-1.5" htmlFor="prov-name">
                {COPY.name.label}
              </label>
              <input
                id="prov-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setErrors((p) => ({ ...p, name: "" }));
                }}
                placeholder={COPY.name.placeholder}
                autoFocus
                className="w-full h-9 px-3 text-sm rounded-md border border-input bg-background font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {errors.name ? (
                <p className="text-xs text-destructive mt-1">{errors.name}</p>
              ) : (
                <p className="text-xs text-muted-foreground mt-1.5">{COPY.name.hint}</p>
              )}
            </div>
          )}

          <div>
            <label className="text-sm font-medium block mb-1.5" htmlFor="prov-url">
              {COPY.url.label}
            </label>
            <div className="flex gap-2">
              <input
                id="prov-url"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setErrors((p) => ({ ...p, url: "" }));
                  setTestResult(null);
                }}
                placeholder={COPY.url.placeholder}
                autoFocus={isEdit}
                className="flex-1 h-9 px-3 text-sm rounded-md border border-input bg-background font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-9 text-xs gap-1.5 shrink-0"
                onClick={() => void runTest()}
                disabled={testing || !url.trim()}
              >
                {testing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Zap className="h-3.5 w-3.5" />
                )}
                {testing ? COPY.actions.testing : COPY.actions.test}
              </Button>
            </div>
            {errors.url ? (
              <p className="text-xs text-destructive mt-1">{errors.url}</p>
            ) : (
              <p className="text-xs text-muted-foreground mt-1.5">{COPY.url.hint}</p>
            )}
            {testResult && (
              <p
                className={cn(
                  "text-xs mt-1.5 inline-flex items-center gap-1.5",
                  testResult.ok ? "text-foreground" : "text-destructive",
                )}
              >
                {testResult.ok ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <X className="h-3 w-3" />
                )}
                {testResult.ok
                  ? COPY.testResult.ok(testResult.latencyMs)
                  : COPY.testResult.fail(testResult.error ?? COPY.testResult.unknownReason)}
              </p>
            )}
          </div>

          {profilesEnabled && (
            <div>
              <label className="text-sm font-medium block mb-1.5">
                {COPY.profile.label}
              </label>
              <Select
                value={profile}
                options={profileOptions}
                onChange={setProfile}
                fullWidth
              />
              <p className="text-xs text-muted-foreground mt-1.5">{profileHint}</p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="text-sm font-medium block mb-1.5" htmlFor="prov-max">
                {COPY.maxConcurrent.label}
              </label>
              <input
                id="prov-max"
                type="number"
                min="1"
                value={maxConcurrent}
                onChange={(e) => {
                  setMaxConcurrent(e.target.value);
                  setErrors((p) => ({ ...p, maxConcurrent: "" }));
                }}
                placeholder={COPY.maxConcurrent.placeholder}
                className="w-full h-9 px-3 text-sm rounded-md border border-input bg-background font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {errors.maxConcurrent ? (
                <p className="text-xs text-destructive mt-1">{errors.maxConcurrent}</p>
              ) : (
                <p className="text-xs text-muted-foreground mt-1.5">{COPY.maxConcurrent.hint}</p>
              )}
            </div>

            <div>
              <label className="text-sm font-medium block mb-1.5" htmlFor="prov-priority">
                {COPY.priority.label}
              </label>
              <input
                id="prov-priority"
                type="number"
                min="1"
                value={priority}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n >= 1) setPriority(n);
                }}
                placeholder="100"
                className="w-full h-9 px-3 text-sm rounded-md border border-input bg-background font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {errors.priority ? (
                <p className="text-xs text-destructive mt-1">{errors.priority}</p>
              ) : (
                <>
                  <p className="text-xs text-foreground mt-1.5">{priorityEffect.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{COPY.priority.hintStatic}</p>
                </>
              )}
            </div>

            <div>
              <label className="text-sm font-medium block mb-1.5" htmlFor="prov-weight">
                {COPY.weight.label}
              </label>
              <input
                id="prov-weight"
                type="number"
                min="1"
                value={weight}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n >= 1) setWeight(n);
                }}
                placeholder="100"
                className="w-full h-9 px-3 text-sm rounded-md border border-input bg-background font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {errors.weight ? (
                <p className="text-xs text-destructive mt-1">{errors.weight}</p>
              ) : (
                <>
                  <p className="text-xs text-foreground mt-1.5">{weightEffect.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{COPY.weight.hintStatic}</p>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mt-5">
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          aria-expanded={advancedOpen}
          className="w-full inline-flex items-center gap-2 px-4 py-3 rounded-lg border border-border bg-card hover:bg-muted/40 transition-colors text-left"
        >
          <ChevronRight
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              advancedOpen && "rotate-90",
            )}
            strokeWidth={2}
          />
          <div className="flex-1">
            <div className="text-sm font-medium">{COPY.advanced.label}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Custom headers for Bearer, API-key, or reverse-proxy auth.
              {filledHeaderCount > 0
                ? ` ${filledHeaderCount} configured.`
                : ""}
            </div>
          </div>
        </button>

        {advancedOpen && (
          <Card className="mt-3">
            <CardContent className="p-6 space-y-3">
              <div>
                <label className="text-sm font-medium block">
                  {COPY.advanced.headersLabel}
                </label>
                <p className="text-xs text-muted-foreground mt-1">
                  {COPY.advanced.headersHint}
                </p>
              </div>

              {headers.length > 0 && (
                <div className="space-y-2">
                  {headers.map((h) => {
                    const shown = !!revealed[h.id];
                    return (
                      <div key={h.id} className="flex gap-2 items-start">
                        <input
                          value={h.key}
                          onChange={(e) => updateHeader(h.id, { key: e.target.value })}
                          placeholder={COPY.advanced.headerNamePlaceholder}
                          className="w-1/3 h-9 px-3 text-sm rounded-md border border-input bg-background font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                        <div className="flex-1 relative">
                          <input
                            value={h.value}
                            onChange={(e) => updateHeader(h.id, { value: e.target.value })}
                            placeholder={COPY.advanced.headerValuePlaceholder}
                            type={shown ? "text" : "password"}
                            autoComplete="off"
                            spellCheck={false}
                            className="w-full h-9 px-3 pr-9 text-sm rounded-md border border-input bg-background font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setRevealed((prev) => ({ ...prev, [h.id]: !shown }))
                            }
                            aria-label={shown ? "Hide value" : "Show value"}
                            className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 inline-flex items-center justify-center rounded hover:bg-muted/60 text-muted-foreground"
                          >
                            {shown ? (
                              <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} />
                            ) : (
                              <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
                            )}
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeHeader(h.id)}
                          aria-label="Remove header"
                          className="h-9 w-9 inline-flex items-center justify-center rounded-md hover:bg-muted/60 text-muted-foreground shrink-0"
                        >
                          <X className="h-3.5 w-3.5" strokeWidth={2} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-8 text-xs gap-1.5"
                onClick={addHeaderRow}
              >
                <Plus className="h-3 w-3" strokeWidth={2} />
                {COPY.advanced.addHeader}
              </Button>

              {errors.headers && (
                <p className="text-xs text-destructive">{errors.headers}</p>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {submitError && (
        <p className="text-xs text-destructive mt-3">{submitError}</p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => router.push("/providers")}
          disabled={saving}
        >
          {COPY.actions.cancel}
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
          {isEdit
            ? saving
              ? COPY.actions.saving
              : COPY.actions.saveChanges
            : saving
            ? COPY.actions.adding
            : COPY.actions.addProvider}
        </Button>
      </div>
    </form>
  );
}
