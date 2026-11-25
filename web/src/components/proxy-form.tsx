"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckRow } from "@/components/ui/choice-card";
import { ChipInput } from "@/components/ui/chip-input";
import { DialogActions } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { addProxy, updateProxy, type ProxySummary } from "@/lib/api";

interface Props {
  initial: ProxySummary | null;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function ProxyForm({ initial, onSaved, onCancel }: Props) {
  const isEdit = initial !== null;
  const [name, setName] = useState(initial?.name ?? "");
  const [address, setAddress] = useState(initial?.server ?? "");
  const [clearLogin, setClearLogin] = useState(false);
  const [bypass, setBypass] = useState<string[]>(initial?.bypass ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keepsSavedLogin = isEdit && initial.hasCredentials && !clearLogin;
  const cannotApply = address.trim().toLowerCase().startsWith("https://") || /^[a-z0-9]+:\/\/[^/@]+@/i.test(address.trim()) || keepsSavedLogin;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isEdit && (!NAME_PATTERN.test(name.trim()) || name.trim().toLowerCase() === "none")) {
      setError("Use letters, numbers, hyphens or underscores. \"none\" is reserved.");
      return;
    }
    setSaving(true);
    setError(null);
    const data = {
      address: address.trim(),
      bypass: bypass.map((b) => b.trim()).filter(Boolean),
      clearCredentials: clearLogin || undefined,
    };
    const res = isEdit ? await updateProxy(initial.name, data) : await addProxy(name.trim(), data);
    setSaving(false);
    if (res.ok) await onSaved();
    else setError([res.error, ...(res.details ?? [])].filter(Boolean).join(": ") || "Could not save proxy");
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-[18px]">
      {!isEdit && (
        <Field
          id="proxy-name"
          label="Name"
          help={
            <>
              Used on the connection URL as <span className="font-mono">?proxy={name.trim() || "home"}</span>
            </>
          }
        >
          <Input id="proxy-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="home" autoFocus className="font-mono" autoComplete="off" />
        </Field>
      )}

      <Field
        id="proxy-address"
        label="Proxy address"
        help={
          <>
            http or socks5, with the port. No username or password. Example: <span className="font-mono">socks5://10.0.4.12:1080</span>
          </>
        }
      >
        <Input
          id="proxy-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="http://proxy.example.com:3128"
          className="font-mono"
          autoComplete="off"
          autoFocus={isEdit}
        />
      </Field>

      {isEdit && initial.hasCredentials && (
        <CheckRow
          checked={clearLogin}
          onChange={setClearLogin}
          title="Remove the saved login"
          note="The proxy is then used without a username and password."
        />
      )}

      <Field
        id="proxy-bypass"
        label="Sites that skip the proxy"
        optional
        help={
          <>
            These hosts connect directly. Press Enter or a comma after each one. Example: <span className="font-mono">localhost, *.internal</span>
          </>
        }
      >
        <ChipInput id="proxy-bypass" value={bypass} onChange={setBypass} placeholder="*.internal" />
      </Field>

      {cannotApply && (
        <Alert variant="warn" title="This gateway cannot apply this proxy">
          A browser cannot use a proxy with a username, password or an https address on its own. Use an http or socks5 proxy that allows your address without a login.
        </Alert>
      )}

      {error && <Alert title="The proxy was not saved">{error}</Alert>}

      <DialogActions>
        <Button type="button" variant="outline" size="lg" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="lg" loading={saving} disabled={!address.trim()}>
          {isEdit ? "Save changes" : "Add proxy"}
        </Button>
      </DialogActions>
    </form>
  );
}
