"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addProxy, updateProxy, type ProxySummary } from "@/lib/api";

interface Props {
  initial: ProxySummary | null;
  onSaved: () => Promise<void>;
}

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function ProxyForm({ initial, onSaved }: Props) {
  const isEdit = initial !== null;
  const [name, setName] = useState(initial?.name ?? "");
  const [address, setAddress] = useState(initial?.server ?? "");
  const [clearLogin, setClearLogin] = useState(false);
  const [bypass, setBypass] = useState(initial?.bypass.join(", ") ?? "");
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
      bypass: bypass.split(",").map((b) => b.trim()).filter(Boolean),
      clearCredentials: clearLogin || undefined,
    };
    const res = isEdit ? await updateProxy(initial.name, data) : await addProxy(name.trim(), data);
    setSaving(false);
    if (res.ok) await onSaved();
    else setError([res.error, ...(res.details ?? [])].filter(Boolean).join(": ") || "Could not save proxy");
  }

  const field = "text-sm font-medium block mb-1.5";
  const hint = "text-xs text-muted-foreground mt-1";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {!isEdit && (
        <div>
          <label htmlFor="proxy-name" className={field}>Name</label>
          <Input id="proxy-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="home" autoFocus className="font-mono" />
          <p className={hint}>Used on the connection URL as <span className="font-mono">?proxy={name.trim() || "name"}</span></p>
        </div>
      )}

      <div>
        <label htmlFor="proxy-address" className={field}>Address</label>
        <Input id="proxy-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="http://proxy.example.com:3128" className="font-mono" autoFocus={isEdit} />
        <p className={hint}>http or socks5, with the port. No username or password.</p>
      </div>

      {isEdit && initial.hasCredentials && (
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={clearLogin} onChange={(e) => setClearLogin(e.target.checked)} className="size-4 rounded border-input accent-foreground" />
          Remove the saved login
        </label>
      )}

      <div>
        <label htmlFor="proxy-bypass" className={field}>Skip the proxy for</label>
        <Input id="proxy-bypass" value={bypass} onChange={(e) => setBypass(e.target.value)} placeholder="localhost, *.internal" className="font-mono" />
        <p className={hint}>Hosts that connect directly, separated by commas. Optional.</p>
      </div>

      {cannotApply && (
        <div className="rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
          A browser cannot use a proxy with a username, password or an https address on its own, so this gateway does not accept one. Use an http or socks5 proxy that allows your address without a login.
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={saving || !address.trim()} className="gap-1.5">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          {isEdit ? "Save changes" : "Add proxy"}
        </Button>
      </div>
    </form>
  );
}
