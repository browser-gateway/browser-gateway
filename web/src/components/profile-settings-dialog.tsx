"use client";

import { useState } from "react";
import { Dialog, DialogActions, DialogHeader } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { setProfileProxy } from "@/lib/api";
import { ProfileProxyField } from "./profile-proxy-field";

interface ProfileSettingsDialogProps {
  id: string;
  proxy: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function ProfileSettingsDialog(props: ProfileSettingsDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} width={560} label={`Edit ${props.id}`}>
      {props.open ? <ProfileSettingsForm {...props} /> : null}
    </Dialog>
  );
}

function ProfileSettingsForm({ id, proxy, onOpenChange, onSaved }: ProfileSettingsDialogProps) {
  const [value, setValue] = useState<string | null>(proxy);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await setProfileProxy(id, value);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The profile was not saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader
        title={<>Edit <span className="t-mono">{id}</span></>}
        description="Settings for sessions that use this profile."
        onClose={() => onOpenChange(false)}
      />
      <ProfileProxyField value={value} onChange={setValue} />
      {error ? <Alert>{error}</Alert> : null}
      <DialogActions>
        <Button variant="outline" size="lg" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" size="lg" onClick={() => void save()} disabled={value === proxy} loading={saving}>
          Save changes
        </Button>
      </DialogActions>
    </>
  );
}
