"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Globe, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProxyForm } from "@/components/proxy-form";
import { ProxyList, type CheckKind } from "@/components/proxy-list";
import {
  checkProxyInBrowser,
  deleteProxy,
  fetchProviders,
  fetchProxies,
  testProxy,
  type ProviderConfigItem,
  type ProxyCheckResult,
  type ProxySummary,
} from "@/lib/api";

export default function ProxiesPage() {
  const [proxies, setProxies] = useState<ProxySummary[] | null>(null);
  const [providers, setProviders] = useState<ProviderConfigItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ProxySummary | null>(null);
  const [results, setResults] = useState<Record<string, { kind: CheckKind; result: ProxyCheckResult }>>({});
  const [testing, setTesting] = useState<{ name: string; kind: CheckKind } | null>(null);

  const refresh = useCallback(
    () =>
      Promise.all([fetchProxies(), fetchProviders()]).then(
        ([x, p]) => {
          setProxies(x.proxies);
          setProviders(p.providers);
        },
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      ),
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applying = providers.filter((p) => p.injectProxy && p.enabled);

  function openForm(proxy: ProxySummary | null) {
    setEditing(proxy);
    setModalOpen(true);
  }

  async function handleTest(name: string, kind: CheckKind) {
    setTesting({ name, kind });
    try {
      const result = kind === "browser" ? await checkProxyInBrowser(name) : await testProxy(name);
      setResults((prev) => ({ ...prev, [name]: { kind, result } }));
    } catch (e) {
      setResults((prev) => ({ ...prev, [name]: { kind, result: { ok: false, error: e instanceof Error ? e.message : String(e), latencyMs: 0 } } }));
    } finally {
      setTesting(null);
    }
  }

  async function handleDelete(name: string) {
    if (!confirm(`Delete proxy ${name}? Connections that ask for it will be refused.`)) return;
    const res = await deleteProxy(name);
    if (res.ok) await refresh();
    else setError(res.error ?? "Could not delete proxy");
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Proxies</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Send a session&apos;s pages through a proxy. Add <span className="font-mono">?proxy=&lt;name&gt;</span> to the connection URL, or set a{" "}
            <Link href="/settings" className="underline underline-offset-2 hover:text-foreground">default proxy</Link>.
          </p>
        </div>
        {proxies && proxies.length > 0 && (
          <Button size="sm" onClick={() => openForm(null)} className="gap-1.5 shrink-0">
            <Plus className="h-3.5 w-3.5" />
            Add Proxy
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="px-5 py-4 space-y-2 text-sm">
          <p className="font-medium">Where proxies apply</p>
          {applying.length > 0 ? (
            <p className="text-muted-foreground">
              Only on providers with Apply proxies turned on: <span className="font-mono text-foreground">{applying.map((p) => p.id).join(", ")}</span>. Sessions on other providers never use a proxy.
            </p>
          ) : (
            <p className="text-muted-foreground">
              No provider has Apply proxies turned on, so connections that ask for a proxy are refused. Turn it on for a browser you run in{" "}
              <Link href="/providers" className="underline underline-offset-2 hover:text-foreground">Providers</Link>.
            </p>
          )}
          <p className="text-muted-foreground">
            This gateway applies http or socks5 proxies without a login. A browser cannot use a proxy with a username, password or an https address on its own.
          </p>
          <p className="text-muted-foreground">Test connects through the proxy from this gateway&apos;s machine. Check in a browser opens a real session through it and shows what that browser reports.</p>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive/50">
          <CardContent className="px-4 py-3 flex items-center justify-between">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="ghost" size="icon-xs" onClick={() => setError(null)}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </CardContent>
        </Card>
      )}

      {proxies && proxies.length === 0 && (
        <Card>
          <CardContent className="p-8 flex flex-col items-center text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
              <Globe className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
            </div>
            <p className="text-lg font-medium">No proxies yet</p>
            <p className="text-sm text-muted-foreground mt-1.5 max-w-lg">Add a proxy address and give it a name. Sessions that ask for it send their pages through it.</p>
            <Button size="sm" onClick={() => openForm(null)} className="gap-1.5 mt-5">
              <Plus className="h-3.5 w-3.5" />
              Add Proxy
            </Button>
          </CardContent>
        </Card>
      )}

      {proxies && proxies.length > 0 && (
        <ProxyList proxies={proxies} results={results} testing={testing} canCheckInBrowser={applying.length > 0} onTest={(n, k) => void handleTest(n, k)} onEdit={openForm} onDelete={(n) => void handleDelete(n)} />
      )}

      {!proxies && !error && (
        <Card><CardContent className="p-6 text-sm text-muted-foreground">Loading...</CardContent></Card>
      )}

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.name}` : "Add a proxy"}</DialogTitle>
            <DialogDescription>Saved to the config file and applied to new sessions at once.</DialogDescription>
          </DialogHeader>
          <ProxyForm
            key={editing?.name ?? "new"}
            initial={editing}
            onSaved={async () => { setModalOpen(false); await refresh(); }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
