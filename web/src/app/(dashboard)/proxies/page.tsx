"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Globe, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogActions, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTile, StatTiles } from "@/components/ui/stat-tile";
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

const ROW_CHIP = "w-fit whitespace-nowrap rounded-[10px] border border-line bg-card px-[9px] py-[3px] font-mono text-xs font-semibold text-fg-soft";

function AttachRow({ title, note, chip, href }: { title: string; note: React.ReactNode; chip: string; href?: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-2xl border border-line bg-ground p-3.5">
      <span className="text-sm font-bold">{title}</span>
      <span className="text-xs text-fg-3">{note}</span>
      {href ? (
        <Link href={href} className={`${ROW_CHIP} hover:border-line-strong`}>
          {chip}
        </Link>
      ) : (
        <span className={ROW_CHIP}>{chip}</span>
      )}
    </div>
  );
}

export default function ProxiesPage() {
  const [proxies, setProxies] = useState<ProxySummary[] | null>(null);
  const [providers, setProviders] = useState<ProviderConfigItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ProxySummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
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

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const res = await deleteProxy(deleteTarget);
    setDeleting(false);
    setDeleteTarget(null);
    if (res.ok) await refresh();
    else setError(res.error ?? "Could not delete proxy");
  }

  const rows = proxies ?? [];
  const usableCount = rows.filter((p) => p.usable).length;

  const explainer = (
    <aside aria-label="Where a proxy applies" className="ui-card ui-card--hero flex min-w-0 flex-[1_1_300px] flex-col gap-3.5 rounded-[28px] p-[22px]">
      <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Where a proxy applies</h2>
      <AttachRow
        title="Gateway default"
        note="Every new session uses it unless the connection says otherwise."
        chip="Settings › Default proxy"
        href="/settings"
      />
      <AttachRow
        title="One connection"
        note="Add it to the connection URL."
        chip="?proxy=<name>"
      />
      <span className="text-xs text-fg-3">
        {applying.length > 0 ? (
          <>
            Only on providers with Apply proxies turned on: <span className="font-mono text-fg-2">{applying.map((p) => p.id).join(", ")}</span>. Sessions on other providers never use a proxy.
          </>
        ) : (
          <>
            No provider has Apply proxies turned on, so connections that ask for a proxy are refused. Turn it on for a browser you run in{" "}
            <Link href="/providers" className="t-link">
              Providers
            </Link>
            .
          </>
        )}
      </span>
      <span className="text-xs text-fg-3">
        This gateway applies http or socks5 proxies without a login. A browser cannot use a proxy with a username, password or an https address on its own.
      </span>
      <span className="text-xs text-fg-3">
        Test connects through the proxy from this gateway&apos;s machine. Check in a browser opens a real session through it and shows what that browser reports.
      </span>
    </aside>
  );

  return (
    <>
      <PageHeader
        title="Proxies"
        description="Send a session's pages through a proxy, so sites see the address and country you choose."
        actions={
          <Button variant="accent" onClick={() => openForm(null)}>
            <Plus strokeWidth={2.4} />
            Add proxy
          </Button>
        }
      />

      {error ? (
        <Alert title="Something went wrong">
          {error}{" "}
          <button
            type="button"
            className="t-link"
            onClick={() => {
              setError(null);
              void refresh();
            }}
          >
            Retry
          </button>
        </Alert>
      ) : null}

      {proxies === null ? (
        error ? null : (
          <>
            <div className="ui-stats">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-[98px] rounded-tile" />
              ))}
            </div>
            <Skeleton className="h-[220px] rounded-card" />
          </>
        )
      ) : (
        <>
          <StatTiles>
            <StatTile label="Proxies" value={rows.length} note="Saved in the config file" highlight />
            <StatTile label="Ready to use" value={usableCount} note={usableCount === rows.length ? "Every proxy can be applied" : "The rest have an address this gateway cannot apply"} />
            <StatTile label="Cannot be used" value={rows.length - usableCount} note="Address this gateway cannot apply" />
            <StatTile
              label="Applies on"
              value={applying.length}
              note={applying.length === 1 ? "Provider with Apply proxies on" : "Providers with Apply proxies on"}
            />
          </StatTiles>

          <div className="flex flex-wrap items-start gap-4">
            <section aria-label="Your proxies" className="flex min-w-0 flex-[3_1_600px] flex-col gap-3">
              <h2 className="m-0 text-xl font-bold leading-[1.2] tracking-[-0.02em]">Your proxies</h2>
              {rows.length === 0 ? (
                <EmptyState
                  icon={Globe}
                  title="No proxies yet"
                  hint="Add a proxy address and give it a name. Sessions that ask for it send their pages through it. Proxies you add show here."
                  action={
                    <Button variant="primary" onClick={() => openForm(null)}>
                      Add proxy
                    </Button>
                  }
                />
              ) : (
                <ProxyList
                  proxies={rows}
                  results={results}
                  testing={testing}
                  canCheckInBrowser={applying.length > 0}
                  onTest={(n, k) => void handleTest(n, k)}
                  onEdit={openForm}
                  onDelete={setDeleteTarget}
                />
              )}
            </section>
            {explainer}
          </div>
        </>
      )}

      <Dialog open={modalOpen} onOpenChange={setModalOpen} width={640} label={editing ? `Edit ${editing.name}` : "Add a proxy"}>
        <DialogHeader
          title={editing ? <>Edit <span className="t-mono">{editing.name}</span></> : "Add a proxy"}
          description="Saved to the config file and applied to new sessions at once."
          onClose={() => setModalOpen(false)}
        />
        <ProxyForm
          key={editing?.name ?? "new"}
          initial={editing}
          onCancel={() => setModalOpen(false)}
          onSaved={async () => {
            setModalOpen(false);
            await refresh();
          }}
        />
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }} width={560} label="Delete proxy">
        <DialogHeader title={<>Delete <span className="t-mono">{deleteTarget}</span>?</>} onClose={() => setDeleteTarget(null)} />
        <DialogBody>Connections that ask for it will be refused.</DialogBody>
        <DialogActions>
          <Button variant="outline" size="lg" onClick={() => setDeleteTarget(null)} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" size="lg" onClick={() => void confirmDelete()} loading={deleting}>
            Delete proxy
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
