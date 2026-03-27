"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { Save, Check, X, Loader2, AlertTriangle, FileCode } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fetchConfig, validateConfig, saveConfig } from "@/lib/api";

const CodeEditor = dynamic(
  () => import("@uiw/react-textarea-code-editor").then((mod) => mod.default),
  { ssr: false }
);

export default function ConfigPage() {
  const [yaml, setYaml] = useState("");
  const [originalYaml, setOriginalYaml] = useState("");
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const handleValidate = async () => {
    setValidating(true);
    setValidation(null);
    setSaveResult(null);
    const result = await validateConfig(yaml);
    setValidation(result);
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
    if (result.ok) {
      setOriginalYaml(yaml);
    }
    setSaving(false);
  };

  const handleDiscard = () => {
    setYaml(originalYaml);
    setValidation(null);
    setSaveResult(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Configuration</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Edit the gateway configuration file directly. Changes are validated before saving.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasChanges && (
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={handleDiscard}>
              Discard
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={handleValidate}
            disabled={validating || !yaml.trim()}
          >
            {validating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Validate
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={handleSave}
            disabled={saving || !hasChanges || !yaml.trim()}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </div>

      {configPath && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <FileCode className="h-3.5 w-3.5" />
          <span className="font-mono">{configPath}</span>
          {hasChanges && <Badge variant="secondary" className="text-[10px] h-4 px-1">unsaved changes</Badge>}
        </div>
      )}

      {validation && !validation.valid && (
        <Card className="border-destructive/50">
          <CardContent className="px-4 py-3 space-y-1">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
              <p className="text-sm font-medium text-destructive">Configuration errors</p>
            </div>
            <ul className="text-xs text-destructive/80 space-y-0.5 ml-6">
              {validation.errors?.map((err, i) => <li key={i} className="font-mono">{err}</li>)}
            </ul>
          </CardContent>
        </Card>
      )}

      {validation && validation.valid && (
        <Card className="border-emerald-500/30">
          <CardContent className="px-4 py-3 flex items-center gap-2">
            <Check className="h-4 w-4 text-emerald-500" />
            <p className="text-sm text-emerald-500">
              Valid configuration with {validation.providerCount} provider{validation.providerCount !== 1 ? "s" : ""}
            </p>
          </CardContent>
        </Card>
      )}

      {saveResult && saveResult.ok && (
        <Card className="border-emerald-500/30">
          <CardContent className="px-4 py-3 flex items-center gap-2">
            <Check className="h-4 w-4 text-emerald-500" />
            <p className="text-sm text-emerald-500">{saveResult.message}</p>
          </CardContent>
        </Card>
      )}

      {saveResult && !saveResult.ok && (
        <Card className="border-destructive/50">
          <CardContent className="px-4 py-3 flex items-center gap-2">
            <X className="h-4 w-4 text-destructive" />
            <p className="text-sm text-destructive">{saveResult.error}</p>
          </CardContent>
        </Card>
      )}

      <Card className="glass overflow-hidden">
        <CardContent className="p-0">
          {loading ? (
            <div className="p-8 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <CodeEditor
              value={yaml}
              language="yaml"
              onChange={(e) => {
                setYaml(e.target.value);
                setValidation(null);
                setSaveResult(null);
              }}
              padding={20}
              style={{
                fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                fontSize: 13,
                lineHeight: 1.6,
                backgroundColor: "transparent",
                minHeight: 400,
              }}
              data-color-mode="dark"
            />
          )}
        </CardContent>
      </Card>

      <div className="text-xs text-muted-foreground space-y-1">
        <p>
          This editor modifies your <span className="font-mono text-foreground/70">gateway.yml</span> file directly.
          A backup is created before each save. Restart the gateway to apply provider changes.
        </p>
        <p>
          Need help? See the{" "}
          <a href="https://browsergateway.io" target="_blank" rel="noopener noreferrer" className="text-foreground/70 underline underline-offset-4">
            configuration reference
          </a>{" "}
          for all available options.
        </p>
      </div>
    </div>
  );
}
