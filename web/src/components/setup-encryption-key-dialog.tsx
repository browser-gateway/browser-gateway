"use client";

import { useState } from "react";
import { Check, Copy, FileText, KeyRound } from "lucide-react";
import { Dialog, DialogActions, DialogHeader } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { useCopy } from "@/components/ui/copy-row";
import { StatusBadge } from "@/components/ui/badge";
import { CodeBlock } from "./code-block";
import { enableProfilesSetup, type EnableProfilesResult } from "@/lib/api";

function generateKeyBase64(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

type Status = "idle" | "applying" | "applied" | "error";

const YAML_SNIPPET = `# add this block to gateway.yml
profiles:
  enabled: true
  filesystem:
    path: ./profiles
  encryption:
    keyEnv: BG_ENCRYPTION_KEY`;

export function SetupEncryptionKeyDialog({ triggerVariant = "primary" }: { triggerVariant?: "primary" | "accent" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={triggerVariant} onClick={() => setOpen(true)}>
        <KeyRound strokeWidth={2} />
        Enable profiles
      </Button>
      <Dialog open={open} onOpenChange={setOpen} width={600} label="Enable profiles">
        <SetupBody onClose={() => setOpen(false)} />
      </Dialog>
    </>
  );
}

function SetupBody({ onClose }: { onClose: () => void }) {
  const [key] = useState<string>(() => generateKeyBase64());
  const [showManual, setShowManual] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [result, setResult] = useState<EnableProfilesResult | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedNow, copy] = useCopy();

  async function handleAutoApply() {
    if (!key) return;
    setStatus("applying");
    setErrMsg(null);
    try {
      setResult(await enableProfilesSetup(key));
      setStatus("applied");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Setup failed. Try again, or set it up by hand.");
      setStatus("error");
    }
  }

  const shellSnippet = key
    ? `# 1. set the key in your environment
export BG_ENCRYPTION_KEY="${key}"

# 2. restart the gateway
browser-gateway serve

# or, if you use a .env file:
echo 'BG_ENCRYPTION_KEY="${key}"' >> .env`
    : "";

  return (
    <>
      <DialogHeader
        title="Enable profiles"
        description={
          <>
            Profiles are encrypted at rest, so the gateway needs a key. A new one is made in your browser. It can be written to the
            gateway&apos;s <span className="t-mono">.env</span> and <span className="t-mono">gateway.yml</span> for you.
          </>
        }
        onClose={onClose}
      />

      {status === "applied" && result ? (
        <SuccessPanel result={result} />
      ) : (
        <>
          <div className="ui-field">
            <span className="t-label">Your new encryption key</span>
            <div className="ui-well flex flex-wrap items-center gap-2.5 border-brand-line py-2.5 pl-4 pr-2.5">
              <code className="t-mono min-w-0 flex-1 basis-[200px] select-all text-[12.5px] leading-relaxed text-[var(--text-code)] [overflow-wrap:anywhere]">
                {key ?? "…"}
              </code>
              <Button
                variant="outline"
                size="sm"
                disabled={!key}
                onClick={() => {
                  if (!key) return;
                  void copy(key);
                  setCopiedKey(true);
                }}
              >
                {copiedNow ? <Check strokeWidth={2.2} /> : <Copy strokeWidth={2} />}
                {copiedNow ? "Copied" : "Copy"}
              </Button>
            </div>
            <Alert variant="warn" title="Save this key now">
              It is not shown again. If it is lost, every stored profile becomes unreadable.
            </Alert>
          </div>

          {!showManual ? (
            <div className="ui-field">
              <span className="t-label">Apply it to the gateway</span>
              <Button variant="outline" size="full" onClick={() => void handleAutoApply()} disabled={!key} loading={status === "applying"} loadingLabel="Writing files">
                Apply automatically (writes .env and gateway.yml)
              </Button>
              {errMsg ? <Alert>{errMsg}</Alert> : null}
              <button type="button" onClick={() => setShowManual(true)} className="t-link w-fit text-xs">
                Set it up by hand instead
              </button>
            </div>
          ) : (
            <div className="ui-field">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="t-label">Set up by hand, then restart</span>
                <button type="button" onClick={() => setShowManual(false)} className="t-link text-xs">
                  Back to automatic
                </button>
              </div>
              <CodeBlock lang="bash" filename=".env and restart" code={shellSnippet} />
              <CodeBlock lang="yaml" filename="gateway.yml" code={YAML_SNIPPET} />
            </div>
          )}
        </>
      )}

      <DialogActions>
        <Button variant="outline" size="lg" onClick={onClose}>
          {status === "applied" ? "Close" : "Cancel"}
        </Button>
        {status !== "applied" ? (
          <Button variant="primary" size="lg" disabled={!copiedKey && status !== "applying"} onClick={onClose}>
            <Check strokeWidth={2.2} />
            I&apos;ve saved my key
          </Button>
        ) : null}
      </DialogActions>
    </>
  );
}

function SuccessPanel({ result }: { result: EnableProfilesResult }) {
  return (
    <div className="flex flex-col gap-3">
      <Alert variant="success" title="Setup complete">
        Restart the gateway for the change to apply. Stop the process (<span className="t-mono">Ctrl+C</span> where it runs) and start it
        again with the same command.
      </Alert>
      <FileStatus
        label="Environment file"
        path={result.envPath}
        good={result.envWritten}
        text={
          result.envWritten
            ? "Key added"
            : result.envAlreadyHadKey
              ? "Already had BG_ENCRYPTION_KEY. Left as it was."
              : "No change"
        }
      />
      <FileStatus
        label="Gateway config"
        path={result.configPath}
        good={result.configWritten}
        text={
          result.configWritten
            ? "Profiles block written"
            : result.configAlreadyHadBlock
              ? "Already had a profiles block. Left as it was."
              : "No change"
        }
      />
    </div>
  );
}

function FileStatus({ label, path, text, good }: { label: string; path: string; text: string; good: boolean }) {
  return (
    <div className="ui-well flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
      <FileText className="size-4 flex-none text-fg-3" strokeWidth={2} />
      <span className="flex min-w-0 flex-[1_1_200px] flex-col gap-0.5">
        <span className="text-sm font-semibold">{label}</span>
        <span className="t-mono truncate text-[11.5px] text-fg-3" title={path}>
          {path}
        </span>
      </span>
      <StatusBadge tone={good ? "good" : "neutral"}>{text}</StatusBadge>
    </div>
  );
}
