"use client";

import { useEffect, useState } from "react";
import { Braces, Camera, ChevronDown, ChevronRight, FileText, Play, type LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { Select, type SelectOption } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ui/tabs";
import { CodeBlock, type CodeLang } from "@/components/code-block";
import { EndpointReference, type EndpointDoc } from "@/components/endpoint-reference";
import { useAuthEnabled } from "@/components/token-autofill";
import { fetchProfiles, fetchProviders, fetchProxies, fetchSettings, routableProviders, type ProfileMetaItem, type ProxySummary } from "@/lib/api";
import { formatBytes } from "@/lib/format-bytes";
import { proxyPickerOptions } from "@/lib/proxy-options";
import { cn } from "@/lib/utils";
import { contentDoc, scrapeDoc, screenshotDoc } from "./docs";

type Endpoint = "screenshot" | "content" | "scrape";
type ShotFormat = "png" | "jpeg";
type ContentFormat = "html" | "markdown" | "text" | "readability";
type CodeLanguage = "curl" | "node" | "python";

interface ScrapeSelector {
  name: string;
  selector: string;
}

interface ResponseMeta {
  status: number;
  ms: number;
  type: string | null;
  bytes: number | null;
}

type RunResult =
  | { kind: "image"; url: string; format: ShotFormat }
  | { kind: "content"; content: Record<string, string> }
  | { kind: "json"; content: string };

interface Pickers {
  profiles: ProfileMetaItem[];
  profilesEnabled: boolean;
  providers: string[];
  proxies: ProxySummary[];
  defaultProxy: string | null;
}

const ENDPOINTS: Array<{ value: Endpoint; icon: LucideIcon; blurb: string; run: string; doc: EndpointDoc }> = [
  { value: "screenshot", icon: Camera, blurb: "An image of the page, visible area or full length.", run: "Take screenshot", doc: screenshotDoc },
  { value: "content", icon: FileText, blurb: "The text of the page as markdown, plain text, HTML or an article.", run: "Get content", doc: contentDoc },
  { value: "scrape", icon: Braces, blurb: "Only the elements you name, as JSON.", run: "Scrape page", doc: scrapeDoc },
];

const SHOT_FORMATS: Array<{ value: ShotFormat; label: string }> = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
];

const CONTENT_FORMATS: ContentFormat[] = ["html", "markdown", "text", "readability"];

const CODE_LANGUAGES: Array<{ value: CodeLanguage; label: string }> = [
  { value: "curl", label: "curl" },
  { value: "node", label: "Node" },
  { value: "python", label: "Python" },
];

const CODE_LANG: Record<CodeLanguage, CodeLang> = { curl: "bash", node: "typescript", python: "python" };

const PAGE_DESCRIPTION = "Screenshots, page content and structured scraping over HTTP, with no browser code.";

const TIMEOUT_MIN_MS = 1000;
const TIMEOUT_MAX_MS = 120_000;
const TIMEOUT_DEFAULT_MS = 30_000;

const TOKEN_ENV = "BG_TOKEN";

function gatewayHttpBase(): string {
  if (typeof window === "undefined") return "http://localhost:9500";
  const host = window.location.host.includes("9501") ? window.location.host.replace("9501", "9500") : window.location.host;
  return `${window.location.protocol}//${host}`;
}

export default function ApiPage() {
  const [tab, setTab] = useState<Endpoint>("screenshot");
  const [pickers, setPickers] = useState<Pickers | null>(null);
  const authEnabled = useAuthEnabled();

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchProfiles().catch(() => ({ enabled: false, profiles: [] as ProfileMetaItem[] })),
      fetchProviders().catch(() => ({ providers: [] })),
      fetchProxies().catch(() => ({ proxies: [] as ProxySummary[] })),
      fetchSettings().catch(() => null),
    ]).then(([profiles, providers, proxies, settings]) => {
      if (cancelled) return;
      setPickers({
        profiles: profiles.profiles,
        profilesEnabled: profiles.enabled,
        providers: routableProviders(providers.providers).map((p) => p.id),
        proxies: proxies.proxies,
        defaultProxy: settings?.sessionDefaults.proxy ?? null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const config = ENDPOINTS.find((e) => e.value === tab)!;

  return (
    <>
      <PageHeader
        title="REST API"
        description={PAGE_DESCRIPTION}
        actions={
          <a href="https://docs.browsergateway.com/rest-api" target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline" })}>
            API reference ↗
          </a>
        }
      />

      <nav aria-label="Endpoints" className="grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-3">
        {ENDPOINTS.map((e) => {
          const active = e.value === tab;
          return (
            <button
              key={e.value}
              type="button"
              aria-pressed={active}
              onClick={() => setTab(e.value)}
              className={cn(
                "ui-card flex items-start gap-3 rounded-[22px] px-[18px] py-4 text-left text-fg transition-colors",
                active ? "ui-card--selected" : "hover:border-line-strong",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex h-10 w-10 flex-none items-center justify-center rounded-[13px]",
                  active ? "bg-brand-soft text-brand-text" : "bg-ground text-fg-2",
                )}
              >
                <e.icon className="size-[18px]" strokeWidth={2} />
              </span>
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <MethodChip />
                  <span className="font-mono text-sm font-medium">/v1/{e.value}</span>
                </span>
                <span className="text-xs text-fg-2">{e.blurb}</span>
              </span>
            </button>
          );
        })}
      </nav>

      {pickers ? (
        <TrySection key={tab} tab={tab} run={config.run} pickers={pickers} authEnabled={authEnabled} />
      ) : (
        <div role="status" aria-label="Loading" className="flex flex-wrap gap-4">
          <Skeleton className="h-[420px] min-w-0 flex-[1_1_440px] rounded-[28px]" />
          <Skeleton className="h-[420px] min-w-0 flex-[1_1_440px] rounded-[24px]" />
        </div>
      )}

      <Reference tab={tab} doc={config.doc} />
    </>
  );
}

function MethodChip() {
  return <span className="rounded-md border border-line-strong px-[5px] py-px font-mono text-[10px] font-medium text-fg-2">POST</span>;
}

function TrySection({ tab, run, pickers, authEnabled }: { tab: Endpoint; run: string; pickers: Pickers; authEnabled: boolean }) {
  const [url, setUrl] = useState("https://example.com");
  const [shotFormat, setShotFormat] = useState<ShotFormat>("png");
  const [fullPage, setFullPage] = useState(false);
  const [formats, setFormats] = useState<ContentFormat[]>(["markdown"]);
  const [selectors, setSelectors] = useState<ScrapeSelector[]>([{ name: "title", selector: "h1" }]);
  const [profile, setProfile] = useState("");
  const [provider, setProvider] = useState("");
  const [proxy, setProxy] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(TIMEOUT_DEFAULT_MS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [activeFormat, setActiveFormat] = useState<string>("markdown");
  const [meta, setMeta] = useState<ResponseMeta | null>(null);
  const [language, setLanguage] = useState<CodeLanguage>("curl");

  const endpointPath = `/v1/${tab}`;

  function requestBody(): Record<string, unknown> {
    const body: Record<string, unknown> =
      tab === "screenshot"
        ? { url, format: shotFormat, fullPage }
        : tab === "content"
          ? { url, formats }
          : { url, selectors: selectors.filter((s) => s.name && s.selector) };
    if (timeoutMs !== TIMEOUT_DEFAULT_MS) body.timeout = timeoutMs;
    if (profile) body.profile = profile;
    if (provider) body.provider = provider;
    if (proxy) body.proxy = proxy;
    return body;
  }

  function setSel(i: number, field: keyof ScrapeSelector, value: string) {
    setSelectors((prev) => prev.map((s, idx) => (idx === i ? { ...s, [field]: value } : s)));
  }

  function toggleFormat(fmt: ContentFormat) {
    setFormats((prev) => (prev.includes(fmt) ? prev.filter((f) => f !== fmt) : [...prev, fmt]));
  }

  async function handleRun() {
    if (!url) return;
    setLoading(true);
    setError(null);
    if (result?.kind === "image") URL.revokeObjectURL(result.url);
    setResult(null);
    setMeta(null);
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const res = await fetch(endpointPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(requestBody()),
      });
      const type = res.headers.get("Content-Type");

      if (tab === "screenshot") {
        if (!res.ok) {
          const text = await res.text();
          setMeta({ status: res.status, ms: elapsed(), type, bytes: null });
          throw new Error(text.slice(0, 400) || `HTTP ${res.status}`);
        }
        const blob = await res.blob();
        setMeta({ status: res.status, ms: elapsed(), type: blob.type || type, bytes: blob.size });
        setResult({ kind: "image", url: URL.createObjectURL(blob), format: shotFormat });
        return;
      }

      const raw = await res.text();
      setMeta({ status: res.status, ms: elapsed(), type, bytes: new Blob([raw]).size });
      const json = JSON.parse(raw) as { success?: boolean; data?: unknown; error?: string };
      if (!res.ok || json.success === false) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (tab === "content") {
        const data = json.data as { content: Record<string, string> } | null | undefined;
        if (data) {
          setResult({ kind: "content", content: data.content });
          setActiveFormat(formats[0] ?? "markdown");
        }
      } else {
        setResult({ kind: "json", content: JSON.stringify(json.data ?? null, null, 2) });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const code = buildCode(language, `${gatewayHttpBase()}${endpointPath}`, tab === "screenshot", requestBody(), authEnabled);
  const urlId = `rest-url-${tab}`;
  const timeoutId = `rest-timeout-${tab}`;
  const contentFormats = result?.kind === "content" ? Object.keys(result.content) : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-stretch gap-4">
        <section aria-label="Request" className="ui-card ui-card--hero flex min-w-0 flex-[1_1_440px] flex-col gap-[18px] px-6 py-[22px] max-[860px]:px-5">
          <h2 className="t-h2">Try it</h2>

          <Field id={urlId} label="Page address" help="The page to load. Example: https://en.wikipedia.org/wiki/Main_Page">
            <Input id={urlId} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" className="font-mono text-[13px]" />
          </Field>

          {tab === "screenshot" ? (
            <div className="flex flex-wrap items-end gap-[18px]">
              <div className="flex flex-col gap-[7px]">
                <span className="t-label">Format</span>
                <Segmented<ShotFormat> label="Format" value={shotFormat} options={SHOT_FORMATS} onChange={setShotFormat} />
              </div>
              <div className="flex min-h-10 items-center gap-3">
                <Switch checked={fullPage} onCheckedChange={setFullPage} label="Full page" />
                <span className="flex flex-col gap-px">
                  <span className="text-sm font-bold">Full page</span>
                  <span className="text-xs text-fg-3">Scroll and capture the whole page</span>
                </span>
              </div>
            </div>
          ) : null}

          {tab === "content" ? (
            <div className="flex flex-col gap-[7px]">
              <span className="t-label">Formats</span>
              <div role="group" aria-label="Formats" className="flex flex-wrap gap-1.5">
                {CONTENT_FORMATS.map((fmt) => (
                  <button key={fmt} type="button" aria-pressed={formats.includes(fmt)} onClick={() => toggleFormat(fmt)} className="ui-pill font-mono">
                    {fmt}
                  </button>
                ))}
              </div>
              <p className="t-small">Pick one or more. Example: markdown for an LLM, text for a search index.</p>
            </div>
          ) : null}

          {tab === "scrape" ? (
            <div className="flex flex-col gap-[7px]">
              <span className="t-label">Elements</span>
              <div className="flex flex-col gap-2">
                {selectors.map((sel, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <Input
                      aria-label={`Element ${i + 1} name`}
                      value={sel.name}
                      onChange={(e) => setSel(i, "name", e.target.value)}
                      placeholder="name"
                      className="min-w-[120px] flex-1 font-mono text-[13px]"
                    />
                    <Input
                      aria-label={`Element ${i + 1} CSS selector`}
                      value={sel.selector}
                      onChange={(e) => setSel(i, "selector", e.target.value)}
                      placeholder="CSS selector"
                      className="min-w-[120px] flex-1 font-mono text-[13px]"
                    />
                    {selectors.length > 1 ? (
                      <Button variant="outline" size="sm" onClick={() => setSelectors((prev) => prev.filter((_, idx) => idx !== i))}>
                        Remove
                      </Button>
                    ) : null}
                  </div>
                ))}
                <div>
                  <Button variant="outline" size="sm" onClick={() => setSelectors((prev) => [...prev, { name: "", selector: "" }])}>
                    Add element
                  </Button>
                </div>
              </div>
              <p className="t-small">A name for each value and the CSS selector that finds it. Example: title and h1.</p>
            </div>
          ) : null}

          <RoutingFields
            pickers={pickers}
            profile={profile}
            onProfile={setProfile}
            provider={provider}
            onProvider={setProvider}
            proxy={proxy}
            onProxy={setProxy}
          />

          <div className="flex flex-col gap-[7px]">
            <label htmlFor={timeoutId} className="t-label">
              Give up after
            </label>
            <div className="flex items-center gap-2.5">
              <Input
                id={timeoutId}
                type="number"
                inputMode="numeric"
                min={TIMEOUT_MIN_MS / 1000}
                max={TIMEOUT_MAX_MS / 1000}
                step={1}
                value={timeoutMs / 1000}
                onChange={(e) => {
                  const raw = Number(e.target.value) * 1000;
                  setTimeoutMs(Math.max(TIMEOUT_MIN_MS, Math.min(TIMEOUT_MAX_MS, Number.isFinite(raw) ? raw : TIMEOUT_DEFAULT_MS)));
                }}
                className="w-[120px] font-mono"
              />
              <span className="text-sm text-fg-2">seconds</span>
            </div>
            <span className="t-small">
              {TIMEOUT_MIN_MS / 1000} to {TIMEOUT_MAX_MS / 1000} seconds. Default {TIMEOUT_DEFAULT_MS / 1000}. Raise it for slow pages or providers.
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-line-divider pt-[18px]">
            <Button variant="primary" size="lg" onClick={() => void handleRun()} loading={loading} disabled={!url}>
              {loading ? null : <Play strokeWidth={2.2} />}
              {run}
            </Button>
            <span className="flex-[1_1_200px] text-xs text-fg-3">Runs on this gateway with your dashboard login.</span>
          </div>
        </section>

        <section aria-label="Code" className="ui-card flex min-w-0 flex-[1_1_440px] flex-col gap-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Code</h2>
            <Segmented label="Language" value={language} options={CODE_LANGUAGES} onChange={setLanguage} />
          </div>
          <CodeBlock code={code} lang={CODE_LANG[language]} filename={language === "curl" ? "shell" : language} />
          <span className="text-xs text-fg-3">
            {authEnabled
              ? `Reads your gateway token from the ${TOKEN_ENV} environment variable and sends it as a Bearer token.`
              : "This gateway has no token set, so requests need no auth header."}
          </span>
        </section>
      </div>

      <section aria-label="Response" className="ui-card flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Response</h2>
          {meta ? (
            <span className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "rounded-[10px] px-[9px] py-[3px] text-xs font-bold",
                  meta.status >= 200 && meta.status < 300 && !error ? "bg-good-bg text-good" : "bg-bad-bg text-bad",
                )}
              >
                {meta.status}
              </span>
              <span className="font-mono text-xs text-fg-2">{metaLine(meta)}</span>
            </span>
          ) : null}
        </div>

        {loading ? (
          <Skeleton className="mx-auto aspect-[16/10] w-full max-w-[640px] rounded-[14px]" />
        ) : error ? (
          <Alert variant="destructive" title="The request failed">
            <span className="font-mono text-xs [overflow-wrap:anywhere]">{error}</span>
          </Alert>
        ) : result?.kind === "image" ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={result.url} alt="Screenshot result" className="mx-auto block max-w-full rounded-[14px] border border-line" />
            <div className="flex justify-end">
              <a href={result.url} download={`screenshot.${result.format}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Download
              </a>
            </div>
          </>
        ) : result?.kind === "content" && contentFormats.length > 0 ? (
          <>
            {contentFormats.length > 1 ? (
              <Segmented
                label="Format"
                value={activeFormat}
                options={contentFormats.map((f) => ({ value: f, label: f }))}
                onChange={setActiveFormat}
                className="w-fit max-w-full"
              />
            ) : null}
            <CodeBlock code={result.content[activeFormat] ?? ""} lang={activeFormat === "html" ? "typescript" : "bash"} filename={activeFormat} maxHeight="400px" />
          </>
        ) : result?.kind === "json" ? (
          <CodeBlock code={result.content} lang="json" filename="result.json" maxHeight="400px" />
        ) : (
          <div className="flex min-h-[160px] items-center justify-center rounded-2xl border border-dashed border-line-strong bg-ground p-6 text-center text-sm text-fg-3">
            Run the request and the result shows here.
          </div>
        )}
      </section>
    </div>
  );
}

function RoutingFields({
  pickers,
  profile,
  onProfile,
  provider,
  onProvider,
  proxy,
  onProxy,
}: {
  pickers: Pickers;
  profile: string;
  onProfile: (v: string) => void;
  provider: string;
  onProvider: (v: string) => void;
  proxy: string;
  onProxy: (v: string) => void;
}) {
  const showProfile = pickers.profilesEnabled;
  const showProvider = pickers.providers.length > 1;
  const showProxy = pickers.proxies.length > 0;
  if (!showProfile && !showProvider && !showProxy) return null;

  const profileOptions: SelectOption[] = [{ value: "", label: "None" }, ...pickers.profiles.map((p) => ({ value: p.id, label: p.id }))];
  const providerOptions: SelectOption[] = [{ value: "", label: "Any provider" }, ...pickers.providers.map((id) => ({ value: id, label: id }))];
  const proxyOptions: SelectOption[] = [
    { value: "", label: pickers.defaultProxy ? `Default (${pickers.defaultProxy})` : "Default (no proxy)" },
    ...(pickers.defaultProxy ? [{ value: "none", label: "None" }] : []),
    ...proxyPickerOptions(pickers.proxies),
  ];

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-[18px]">
      {showProfile ? (
        <Field label="Profile" optional help="Runs with the saved cookies and storage of this profile.">
          <Select label="Profile" value={profile} options={profileOptions} onChange={onProfile} fullWidth />
        </Field>
      ) : null}
      {showProvider ? (
        <Field label="Provider" optional help="Pins the request to one provider. No failover when pinned.">
          <Select label="Provider" value={provider} options={providerOptions} onChange={onProvider} fullWidth />
        </Field>
      ) : null}
      {showProxy ? (
        <Field label="Proxy" optional help="Loads the page through this proxy, on a provider with Apply proxies on.">
          <Select label="Proxy" value={proxy} options={proxyOptions} onChange={onProxy} fullWidth />
        </Field>
      ) : null}
    </div>
  );
}

function metaLine(meta: ResponseMeta): string {
  const parts = [`${meta.ms.toLocaleString()} ms`];
  if (meta.type) parts.push(meta.type.split(";")[0]!.trim());
  if (meta.bytes !== null) parts.push(formatBytes(meta.bytes));
  return parts.join(" · ");
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? line : pad + line))
    .join("\n");
}

function toPython(value: unknown, depth = 1): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  const pad = "    ".repeat(depth);
  const end = "    ".repeat(depth - 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((v) => pad + toPython(v, depth + 1)).join(",\n")},\n${end}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  return `{\n${entries.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${toPython(v, depth + 1)}`).join(",\n")},\n${end}}`;
}

function buildCode(language: CodeLanguage, endpoint: string, isImage: boolean, body: Record<string, unknown>, auth: boolean): string {
  const json = JSON.stringify(body, null, 2);
  const file = `screenshot.${body.format === "jpeg" ? "jpeg" : "png"}`;
  if (language === "curl") {
    const lines = [
      `curl -X POST "${endpoint}" \\`,
      ...(auth ? [`  -H "Authorization: Bearer $${TOKEN_ENV}" \\`] : []),
      `  -H "Content-Type: application/json" \\`,
      `  -d '${indent(json.replaceAll("'", "'\\''"), 2)}'${isImage ? " \\" : ""}`,
    ];
    if (isImage) lines.push(`  --output ${file}`);
    return lines.join("\n");
  }
  if (language === "node") {
    return [
      `const res = await fetch("${endpoint}", {`,
      `  method: "POST",`,
      `  headers: {`,
      ...(auth ? [`    Authorization: \`Bearer \${process.env.${TOKEN_ENV}}\`,`] : []),
      `    "Content-Type": "application/json",`,
      `  },`,
      `  body: JSON.stringify(${indent(json, 2)}),`,
      `});`,
      isImage ? `const image = Buffer.from(await res.arrayBuffer());` : `const { data } = await res.json();`,
    ].join("\n");
  }
  return [
    ...(auth ? [`import os`] : []),
    `import requests`,
    ``,
    `res = requests.post(`,
    `    "${endpoint}",`,
    ...(auth ? [`    headers={"Authorization": f"Bearer {os.environ['${TOKEN_ENV}']}"},`] : []),
    `    json=${toPython(body, 2)},`,
    `)`,
    isImage ? `image = res.content` : `data = res.json()["data"]`,
  ].join("\n");
}

function Reference({ tab, doc }: { tab: Endpoint; doc: EndpointDoc }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-label="Reference" className="ui-card ui-card--plain">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-[18px] py-3.5 text-left"
        aria-expanded={open}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <MethodChip />
          <code className="font-mono text-[13px] [overflow-wrap:anywhere]">/v1/{tab}</code>
          <span className="text-xs text-fg-3">Reference</span>
        </span>
        <Chevron aria-hidden="true" className="size-[15px] flex-none text-fg-3" strokeWidth={2} />
      </button>
      {open ? (
        <div className="border-t border-line-divider px-[18px] pb-[18px] pt-3.5">
          <EndpointReference doc={doc} />
        </div>
      ) : null}
    </section>
  );
}
