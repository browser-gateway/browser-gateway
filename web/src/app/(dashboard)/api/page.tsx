"use client";

/**
 * REST API page. One tab per endpoint. Inside each: Reference docs and an
 * interactive Try-it form, separated as inner tabs.
 *
 * Reference docs are driven by structured data in `./docs.ts` so they stay
 * consistent across endpoints. The forms hit the real /v1 endpoints with the
 * dashboard's auth cookie.
 */
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Play } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeBlock } from "@/components/code-block";
import { EndpointReference } from "@/components/endpoint-reference";
import { fetchProfiles, type ProfileMetaItem, fetchProviders } from "@/lib/api";
import { contentDoc, scrapeDoc, screenshotDoc } from "./docs";

export default function ApiPage() {
  const [profiles, setProfiles] = useState<ProfileMetaItem[] | null>(null);
  const [profilesEnabled, setProfilesEnabled] = useState<boolean>(false);
  const [providers, setProviders] = useState<{ id: string }[]>([]);

  useEffect(() => {
    fetchProfiles()
      .then((r) => {
        setProfilesEnabled(r.enabled);
        setProfiles(r.profiles);
      })
      .catch(() => {
        setProfilesEnabled(false);
        setProfiles([]);
      });
    fetchProviders()
      .then((r) => setProviders(r.providers.map((p) => ({ id: p.id }))))
      .catch(() => setProviders([]));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">REST API</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Three HTTP endpoints for screenshots, content extraction, and structured scraping. Try each one from the dashboard or read its reference.
        </p>
      </div>

      <Tabs defaultValue="screenshot" className="w-full">
        <TabsList variant="line" className="border-b border-border/40 rounded-none gap-4 px-0 mb-4">
          <EndpointTab value="screenshot" method="POST" path="/v1/screenshot" />
          <EndpointTab value="content" method="POST" path="/v1/content" />
          <EndpointTab value="scrape" method="POST" path="/v1/scrape" />
        </TabsList>

        <TabsContent value="screenshot" className="mt-2 space-y-4">
          <EndpointSection
            featureTitle="Capture a screenshot"
            featureDescription="Render any URL as a PNG or JPEG image, optionally full-page or scoped to a single element."
            method="POST"
            path="/v1/screenshot"
            doc={screenshotDoc}
            actionPanel={<ScreenshotForm profiles={profiles ?? []} profilesEnabled={profilesEnabled} providers={providers} />}
          />
        </TabsContent>

        <TabsContent value="content" className="mt-2 space-y-4">
          <EndpointSection
            featureTitle="Extract page content"
            featureDescription="Fetch a page and return its content as markdown, plain text, HTML, or a Readability-style article."
            method="POST"
            path="/v1/content"
            doc={contentDoc}
            actionPanel={<ContentForm profiles={profiles ?? []} profilesEnabled={profilesEnabled} providers={providers} />}
          />
        </TabsContent>

        <TabsContent value="scrape" className="mt-2 space-y-4">
          <EndpointSection
            featureTitle="Scrape with selectors"
            featureDescription="Extract structured data from a page using named CSS selectors. Combine with content formats for one-shot capture."
            method="POST"
            path="/v1/scrape"
            doc={scrapeDoc}
            actionPanel={<ScrapeForm profiles={profiles ?? []} profilesEnabled={profilesEnabled} providers={providers} />}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function EndpointTab({ value, method, path }: { value: string; method: string; path: string }) {
  return (
    <TabsTrigger value={value} className="px-1 pb-2 data-active:!text-foreground gap-2">
      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-border/40 text-muted-foreground tabular-nums">
        {method}
      </span>
      <code className="font-mono text-[12.5px]">{path}</code>
    </TabsTrigger>
  );
}

function EndpointSection(props: {
  featureTitle: string;
  featureDescription: string;
  method: string;
  path: string;
  doc: typeof screenshotDoc;
  actionPanel: React.ReactNode;
}) {
  const [docsOpen, setDocsOpen] = useState(false);

  return (
    <>
      {/* Primary feature panel. Elevated styling and dense content to read as
          the real product surface, not a sandbox. */}
      <Card className="glass border-border/60">
        <CardContent className="px-5 py-5 space-y-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold tracking-tight">{props.featureTitle}</h2>
            <p className="text-[13px] text-muted-foreground">{props.featureDescription}</p>
          </div>
          <div className="space-y-3">{props.actionPanel}</div>
        </CardContent>
      </Card>

      {/* Secondary, collapsible reference docs. Flat container, no Card so
          the visual weight stays on the feature panel above. */}
      <div className="rounded-lg border border-border/30 bg-muted/10">
        <button
          onClick={() => setDocsOpen((v) => !v)}
          className="flex items-center justify-between w-full px-4 py-2.5 group"
          aria-expanded={docsOpen}
        >
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] font-mono px-1.5 py-0.5 rounded border border-border/40 text-muted-foreground tabular-nums">
              {props.method}
            </span>
            <code className="font-mono text-[12.5px] text-foreground/90">{props.path}</code>
            <span className="text-[11px] text-muted-foreground ml-2">API reference</span>
          </div>
          {docsOpen ? (
            <ChevronDown className="size-3.5 text-muted-foreground group-hover:text-foreground" />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground group-hover:text-foreground" />
          )}
        </button>
        {docsOpen && (
          <div className="px-4 pb-4 pt-1 border-t border-border/20">
            <EndpointReference doc={props.doc} />
          </div>
        )}
      </div>
    </>
  );
}

// ---------- shared form helpers (kept identical to the previous page so the
// forms continue to behave the same) ----------

interface FormSectionProps {
  profiles: ProfileMetaItem[];
  profilesEnabled: boolean;
  providers: { id: string }[];
}

function ScreenshotForm({ profiles, profilesEnabled, providers }: FormSectionProps) {
  const [url, setUrl] = useState("https://example.com");
  const [format, setFormat] = useState<"png" | "jpeg">("png");
  const [fullPage, setFullPage] = useState(false);
  const [profile, setProfile] = useState("");
  const [provider, setProvider] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<number | null>(null);

  async function handleRun() {
    if (!url) return;
    setLoading(true);
    setError(null);
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageUrl(null);
    setImageSize(null);
    try {
      const body: Record<string, unknown> = { url, format, fullPage };
      if (profile) body.profile = profile;
      if (provider) body.provider = provider;
      const res = await fetch("/v1/screenshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text.slice(0, 400) || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      setImageSize(blob.size);
      setImageUrl(URL.createObjectURL(blob));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <FormRow label="URL">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" className="font-mono text-[13px]" />
      </FormRow>
      <FormRow label="Format">
        <NativeSelect value={format} onChange={(e) => setFormat(e.target.value as "png" | "jpeg")}>
          <option value="png">PNG</option>
          <option value="jpeg">JPEG</option>
        </NativeSelect>
      </FormRow>
      <FormRow label="Full page">
        <label className="text-[13px] text-muted-foreground flex items-center gap-2">
          <input type="checkbox" checked={fullPage} onChange={(e) => setFullPage(e.target.checked)} className="accent-foreground" />
          Scroll and stitch the entire page
        </label>
      </FormRow>
      <ProfileDropdown profiles={profiles} profilesEnabled={profilesEnabled} value={profile} onChange={setProfile} />
      <ProviderDropdown providers={providers} value={provider} onChange={setProvider} />

      <RunButton loading={loading} onClick={handleRun} label="Run screenshot" />
      {error && <ErrorBlock message={error} />}

      {imageUrl && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[12px] font-medium text-foreground/80">Response</p>
            <a href={imageUrl} download={`screenshot.${format}`} className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2">
              Download
            </a>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="Screenshot result" className="max-w-full rounded border border-border/40" />
          <p className="text-[11px] text-muted-foreground tabular-nums">
            {format.toUpperCase()} · {imageSize ? formatBytes(imageSize) : ""}
          </p>
        </div>
      )}
    </>
  );
}

function ContentForm({ profiles, profilesEnabled, providers }: FormSectionProps) {
  const [url, setUrl] = useState("https://example.com");
  const [formats, setFormats] = useState<string[]>(["markdown"]);
  const [profile, setProfile] = useState("");
  const [provider, setProvider] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ content: Record<string, string> } | null>(null);
  const [activeFormat, setActiveFormat] = useState("markdown");

  async function handleRun() {
    if (!url) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const body: Record<string, unknown> = { url, formats };
      if (profile) body.profile = profile;
      if (provider) body.provider = provider;
      const res = await fetch("/v1/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { success?: boolean; data?: { content: Record<string, string> }; error?: string };
      if (!res.ok || json.success === false) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setResult(json.data ?? null);
      setActiveFormat(formats[0] ?? "markdown");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function toggleFormat(fmt: string) {
    setFormats((prev) => (prev.includes(fmt) ? prev.filter((f) => f !== fmt) : [...prev, fmt]));
  }

  const availableFormats = result ? Object.keys(result.content) : [];

  return (
    <>
      <FormRow label="URL">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" className="font-mono text-[13px]" />
      </FormRow>
      <FormRow label="Formats">
        <div className="flex flex-wrap gap-3 text-[13px] text-muted-foreground">
          {(["html", "markdown", "text", "readability"] as const).map((fmt) => (
            <label key={fmt} className="flex items-center gap-1.5">
              <input type="checkbox" checked={formats.includes(fmt)} onChange={() => toggleFormat(fmt)} className="accent-foreground" />
              <span className="font-mono text-foreground/80">{fmt}</span>
            </label>
          ))}
        </div>
      </FormRow>
      <ProfileDropdown profiles={profiles} profilesEnabled={profilesEnabled} value={profile} onChange={setProfile} />
      <ProviderDropdown providers={providers} value={provider} onChange={setProvider} />

      <RunButton loading={loading} onClick={handleRun} label="Run content" />
      {error && <ErrorBlock message={error} />}

      {result && availableFormats.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1 flex-wrap">
            {availableFormats.map((fmt) => (
              <button
                key={fmt}
                onClick={() => setActiveFormat(fmt)}
                className={`px-2 py-0.5 rounded text-[11px] font-mono border ${
                  activeFormat === fmt
                    ? "bg-foreground/10 border-foreground/30 text-foreground"
                    : "bg-transparent border-border/30 text-muted-foreground hover:text-foreground"
                }`}
              >
                {fmt}
              </button>
            ))}
          </div>
          <CodeBlock
            code={result.content[activeFormat] ?? ""}
            lang={activeFormat === "html" ? "typescript" : "bash"}
            filename={activeFormat}
            maxHeight="400px"
          />
        </div>
      )}
    </>
  );
}

function ScrapeForm({ profiles, profilesEnabled, providers }: FormSectionProps) {
  const [url, setUrl] = useState("https://example.com");
  const [selectors, setSelectors] = useState<{ name: string; selector: string }[]>([
    { name: "title", selector: "h1" },
  ]);
  const [profile, setProfile] = useState("");
  const [provider, setProvider] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);

  function setSel(i: number, field: "name" | "selector", value: string) {
    setSelectors((prev) => prev.map((s, idx) => (idx === i ? { ...s, [field]: value } : s)));
  }

  function addRow() {
    setSelectors((prev) => [...prev, { name: "", selector: "" }]);
  }

  function removeRow(i: number) {
    setSelectors((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleRun() {
    if (!url) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const cleaned = selectors.filter((s) => s.name && s.selector);
      const body: Record<string, unknown> = { url, selectors: cleaned };
      if (profile) body.profile = profile;
      if (provider) body.provider = provider;
      const res = await fetch("/v1/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { success?: boolean; data?: unknown; error?: string };
      if (!res.ok || json.success === false) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setResult(json.data ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <FormRow label="URL">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" className="font-mono text-[13px]" />
      </FormRow>
      <FormRow label="Selectors">
        <div className="space-y-2 w-full">
          {selectors.map((sel, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={sel.name}
                onChange={(e) => setSel(i, "name", e.target.value)}
                placeholder="name (e.g. title)"
                className="font-mono text-[12.5px] flex-1"
              />
              <Input
                value={sel.selector}
                onChange={(e) => setSel(i, "selector", e.target.value)}
                placeholder="CSS selector (e.g. h1)"
                className="font-mono text-[12.5px] flex-1"
              />
              {selectors.length > 1 && (
                <Button variant="ghost" size="icon-sm" onClick={() => removeRow(i)} className="text-muted-foreground">
                  ×
                </Button>
              )}
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addRow}>
            + Add selector
          </Button>
        </div>
      </FormRow>
      <ProfileDropdown profiles={profiles} profilesEnabled={profilesEnabled} value={profile} onChange={setProfile} />
      <ProviderDropdown providers={providers} value={provider} onChange={setProvider} />

      <RunButton loading={loading} onClick={handleRun} label="Run scrape" />
      {error && <ErrorBlock message={error} />}

      {result !== null && (
        <div className="space-y-2">
          <p className="text-[12px] font-medium text-foreground/80">Response</p>
          <CodeBlock code={JSON.stringify(result, null, 2)} lang="json" filename="result.json" maxHeight="400px" />
        </div>
      )}
    </>
  );
}

function FormRow(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[120px_1fr] gap-2 sm:gap-3 items-start">
      <label className="text-[12px] font-medium text-foreground/80 pt-2">{props.label}</label>
      <div className="min-w-0">{props.children}</div>
    </div>
  );
}

function ProfileDropdown(props: {
  profiles: ProfileMetaItem[];
  profilesEnabled: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  if (!props.profilesEnabled) return null;
  return (
    <FormRow label="Profile">
      <div className="space-y-1">
        <NativeSelect value={props.value} onChange={(e) => props.onChange(e.target.value)}>
          <option value="">(no profile)</option>
          {props.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
            </option>
          ))}
        </NativeSelect>
        <p className="text-[11px] text-muted-foreground">
          Optional. Runs with the saved cookies and storage of this profile.
        </p>
      </div>
    </FormRow>
  );
}

function ProviderDropdown(props: {
  providers: { id: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  if (props.providers.length <= 1) return null;
  return (
    <FormRow label="Provider">
      <div className="space-y-1">
        <NativeSelect value={props.value} onChange={(e) => props.onChange(e.target.value)}>
          <option value="">Auto (gateway picks)</option>
          {props.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
            </option>
          ))}
        </NativeSelect>
        <p className="text-[11px] text-muted-foreground">
          Optional. Pin this request to one backend. No failover when pinned.
        </p>
      </div>
    </FormRow>
  );
}

function NativeSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className="bg-muted/30 border border-border/40 rounded h-10 px-3.5 text-[13px] font-mono w-full focus:outline-none focus:ring-1 focus:ring-foreground/40"
    />
  );
}

function RunButton(props: { loading: boolean; onClick: () => void; label: string }) {
  return (
    <Button onClick={props.onClick} disabled={props.loading} size="sm" className="gap-1.5">
      {props.loading ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
      {props.label}
    </Button>
  );
}

function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="text-[12.5px] text-destructive bg-destructive/10 border border-destructive/30 rounded px-3 py-2 font-mono break-all">
      {message}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
