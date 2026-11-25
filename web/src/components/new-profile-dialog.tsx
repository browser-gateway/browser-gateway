"use client";

import { useState } from "react";
import { Upload } from "lucide-react";
import { Dialog, DialogActions, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { CopyRow } from "@/components/ui/copy-row";
import { buildConnectUrl, maskUrlToken, validateProfileId } from "@/lib/connect-url";
import { createProfile } from "@/lib/api";
import { useGatewayToken } from "./token-autofill";
import { ProfileProxyField } from "./profile-proxy-field";

export type NewProfileMode = "empty" | "import";

interface NewProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: NewProfileMode;
  authEnabled?: boolean;
  onCreated?: (id: string) => void;
  /** Imports the chosen file. Throws with a readable message when it fails. */
  onImport: (file: File) => Promise<void>;
}

export function NewProfileDialog(props: NewProfileDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} width={560} label={props.mode === "empty" ? "New profile" : "Import a profile"}>
      <NewProfileForm key={props.mode} {...props} />
    </Dialog>
  );
}

function NewProfileForm({ onOpenChange, mode, authEnabled, onCreated, onImport }: NewProfileDialogProps) {
  const realToken = useGatewayToken();
  const [id, setId] = useState("");
  const [proxy, setProxy] = useState<string | null>(null);
  const [validationErr, setValidationErr] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverErr, setServerErr] = useState<string | null>(null);


  function handleChange(next: string) {
    setId(next);
    setServerErr(null);
    if (next === "") {
      setValidationErr(null);
      return;
    }
    const r = validateProfileId(next);
    setValidationErr(r.ok ? null : r.reason);
  }

  const realUrl = id && !validationErr ? buildConnectUrl(id, authEnabled ? realToken : null) : "";
  const canCreate = id.length > 0 && !validationErr;

  async function handleCreate() {
    if (!canCreate) return;
    setSaving(true);
    setServerErr(null);
    try {
      await createProfile(id, proxy);
      onCreated?.(id);
      onOpenChange(false);
    } catch (e) {
      setServerErr(e instanceof Error ? e.message : "The profile was not created. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleImport() {
    if (!file) return;
    setSaving(true);
    setServerErr(null);
    try {
      await onImport(file);
      onOpenChange(false);
    } catch (e) {
      setServerErr(e instanceof Error ? e.message : "The import failed. Check the file and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader
        title={mode === "empty" ? "New profile" : "Import a profile"}
        description={
          mode === "empty"
            ? "An empty profile reserves the ID. The first session using it saves the logins and site data when it ends."
            : "Bring in a profile exported from a gateway, or a Playwright storageState. The format is detected from the file."
        }
        onClose={() => onOpenChange(false)}
      />

      {mode === "import" ? (
        <div className="ui-field">
          <span className="t-label">File</span>
          <label className="ui-card ui-card--dashed flex cursor-pointer flex-col items-center gap-1.5 rounded-well px-4 py-6 text-center">
            <Upload className="h-5 w-5 text-fg-3" strokeWidth={2} />
            <span className="text-sm font-semibold [overflow-wrap:anywhere]">{file ? file.name : "Choose a file"}</span>
            <span className="t-small">
              An encrypted <span className="t-mono">.bgp</span> file from this gateway, or a Playwright{" "}
              <span className="t-mono">.json</span>. A JSON file is saved under its file name, for example{" "}
              <span className="t-mono">github.storagestate.json</span> becomes <span className="t-mono">github</span>.
            </span>
            <input
              type="file"
              accept=".bgp,.json,application/json,application/octet-stream"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setServerErr(null);
              }}
              className="sr-only"
            />
          </label>
        </div>
      ) : (
        <>
          <Field
            id="profile-id"
            label="Profile ID"
            help="Used in the connect URL as ?profile=<id>. Letters, digits, dots, dashes and underscores. Example: acme-prod."
            error={validationErr}
          >
            <Input
              id="profile-id"
              value={id}
              onChange={(e) => handleChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canCreate && !saving) void handleCreate();
              }}
              placeholder="acme-prod"
              autoFocus
              className="font-mono"
              aria-invalid={!!validationErr}
            />
          </Field>
          <ProfileProxyField value={proxy} onChange={setProxy} />
          {realUrl ? (
            <div className="ui-field">
              <span className="t-label">Connect URL</span>
              <CopyRow value={maskUrlToken(realUrl)} copyValue={realUrl} />
              {authEnabled ? <p className="t-small">The token is masked on screen. Copy writes the real value.</p> : null}
            </div>
          ) : null}
        </>
      )}

      {serverErr ? <Alert>{serverErr}</Alert> : null}

      <DialogActions>
        <Button variant="outline" size="lg" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        {mode === "empty" ? (
          <Button variant="primary" size="lg" onClick={() => void handleCreate()} disabled={!canCreate} loading={saving}>
            Create profile
          </Button>
        ) : (
          <Button variant="primary" size="lg" onClick={() => void handleImport()} disabled={!file} loading={saving}>
            Import profile
          </Button>
        )}
      </DialogActions>
    </>
  );
}
