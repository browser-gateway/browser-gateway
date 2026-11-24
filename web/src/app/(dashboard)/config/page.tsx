"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Check, Lock, Save } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { DataChip, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchConfig, saveConfig, validateConfig } from "@/lib/api";

const CodeEditor = dynamic(() => import("@uiw/react-textarea-code-editor").then((mod) => mod.default), { ssr: false });

const DESCRIPTION = "Edit the gateway configuration file directly. Changes are checked before they are saved.";

export default function ConfigPage() {
  const [yaml, setYaml] = useState("");
  const [originalYaml, setOriginalYaml] = useState("");
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ valid: boolean; errors?: string[]; providerCount?: number } | null>(null);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; message?: string; error?: string } | null>(null);

  const hasChanges = yaml !== originalYaml;

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchConfig();
      setYaml(data.yaml);
      setOriginalYaml(data.yaml);
      setConfigPath(data.path);
      setHidden(data.hidden === true);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchConfig()
      .then((data) => {
        if (cancelled) return;
        setYaml(data.yaml);
        setOriginalYaml(data.yaml);
        setConfigPath(data.path);
        setHidden(data.hidden === true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleValidate = async () => {
    setValidating(true);
    setValidation(null);
    setSaveResult(null);
    setValidation(await validateConfig(yaml));
    setValidating(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveResult(null);
    setValidation(null);
    const check = await validateConfig(yaml);
    if (!check.valid) {
      setValidation(check);
      setSaving(false);
      return;
    }
    const result = await saveConfig(yaml);
    setSaveResult(result);
    if (result.ok) setOriginalYaml(yaml);
    setSaving(false);
  };

  const handleDiscard = () => {
    setYaml(originalYaml);
    setValidation(null);
    setSaveResult(null);
  };

  if (!loading && hidden) {
    return (
      <>
        <PageHeader title="Configuration" description={DESCRIPTION} />
        <EmptyState
          className="ui-card--hero"
          icon={Lock}
          title="Configuration hidden"
          hint={
            <>
              The file holds provider and webhook credentials, so it is shown only after signing in with the gateway token. Set{" "}
              <span className="t-mono">BG_TOKEN</span> and sign in, or edit <span className="t-mono">gateway.yml</span> on disk.
            </>
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Configuration"
        description={DESCRIPTION}
        meta={configPath ? <DataChip mono className="block max-w-full truncate" title={configPath}>{configPath}</DataChip> : null}
        actions={
          <>
            {hasChanges ? (
              <Button variant="ghost" onClick={handleDiscard}>
                Discard
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => void handleValidate()} disabled={!yaml.trim()} loading={validating}>
              <Check strokeWidth={2} />
              Validate
            </Button>
            <Button variant="primary" onClick={() => void handleSave()} disabled={!hasChanges || !yaml.trim()} loading={saving}>
              <Save strokeWidth={2} />
              Save
            </Button>
          </>
        }
      />

      {loadFailed ? (
        <Alert title="The configuration did not load">
          Check that the gateway is running.{" "}
          <button type="button" className="t-link" onClick={() => void loadConfig()}>
            Retry
          </button>
        </Alert>
      ) : null}

      {validation && !validation.valid ? (
        <Alert title="The configuration has errors">
          <ul className="mt-1 flex flex-col gap-0.5">
            {validation.errors?.map((err, i) => (
              <li key={i} className="t-mono text-xs [overflow-wrap:anywhere]">
                {err}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {validation && validation.valid ? (
        <Alert variant="success" title="Valid configuration">
          {validation.providerCount} provider{validation.providerCount !== 1 ? "s" : ""} found.
        </Alert>
      ) : null}

      {saveResult && saveResult.ok ? <Alert variant="success" title="Saved">{saveResult.message}</Alert> : null}
      {saveResult && !saveResult.ok ? <Alert title="Not saved">{saveResult.error}</Alert> : null}

      <section aria-label="gateway.yml" className="min-w-0 max-w-full overflow-hidden rounded-well border border-line bg-ground">
        <div className="flex min-w-0 items-center justify-between gap-2 border-b border-line py-2 pl-4 pr-2.5">
          <span className="t-mono truncate text-[11px] text-fg-3">gateway.yml</span>
          {hasChanges ? <StatusBadge tone="warn">Unsaved changes</StatusBadge> : null}
        </div>
        {loading ? (
          <div className="flex flex-col gap-2.5 p-5">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="h-3.5 rounded" style={{ width: `${40 + ((i * 37) % 50)}%` }} />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <CodeEditor
              value={yaml}
              language="yaml"
              onChange={(e) => {
                setYaml(e.target.value);
                setValidation(null);
                setSaveResult(null);
              }}
              padding={18}
              style={{
                fontFamily: "var(--font-mono), monospace",
                fontSize: 12.5,
                lineHeight: 1.65,
                backgroundColor: "transparent",
                color: "var(--text-code)",
                minHeight: 400,
              }}
              data-color-mode="dark"
            />
          </div>
        )}
      </section>

      <div className="flex flex-col gap-1">
        <span className="t-small">
          Saving writes <span className="t-mono">gateway.yml</span> directly. A backup is made before each save. Restart the gateway to apply
          provider changes.
        </span>
        <span className="t-small">
          All options are in the{" "}
          <a href="https://docs.browsergateway.com/configuration" target="_blank" rel="noopener noreferrer" className="t-link">
            configuration reference
          </a>
          .
        </span>
      </div>
    </>
  );
}
