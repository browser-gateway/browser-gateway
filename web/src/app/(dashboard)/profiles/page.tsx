"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Download, Info, Power, Trash2, Upload } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ProfileListResponse } from "@/lib/api";
import {
  deleteProfile,
  exportProfileUrl,
  fetchProfiles,
  importProfile,
} from "@/lib/api";
import { IntegrationTabs } from "@/components/integration-tabs";
import { NewProfileDialog } from "@/components/new-profile-dialog";
import { RestartNotice } from "@/components/restart-notice";
import { SetupEncryptionKeyDialog } from "@/components/setup-encryption-key-dialog";
import { disableProfiles } from "@/lib/api";
import { useGatewayToken, useAuthEnabled } from "@/components/token-autofill";
import { buildConnectUrl } from "@/lib/connect-url";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const ageMs = now - d.getTime();
  if (ageMs < 60_000) return "just now";
  if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 24 * 60 * 60_000) return `${Math.floor(ageMs / (60 * 60_000))}h ago`;
  return d.toISOString().slice(0, 10);
}

export default function ProfilesPage() {
  const [data, setData] = useState<ProfileListResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // The intro is collapsed by default to save space for return visitors —
  // first-time users have the empty-state hint inside the table.
  const [introOpen, setIntroOpen] = useState(false);
  const [restartNotice, setRestartNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const authEnabled = useAuthEnabled();

  async function handleDisableProfiles() {
    if (!confirm("Disable profiles? Existing profiles stay on disk. Restart required.")) return;
    setBusy("disable-profiles");
    try {
      const r = await disableProfiles();
      if (r.restartRequired) {
        setRestartNotice("Profiles disabled in gateway.yml.");
      }
    } catch (e: unknown) {
      setMessage({ type: "error", text: `Disable failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  }
  const realToken = useGatewayToken();

  async function handleCopyUrl(profileId: string) {
    const url = buildConnectUrl(profileId, authEnabled ? realToken : null);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(profileId);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      setMessage({ type: "error", text: "Could not copy to clipboard" });
    }
  }

  async function reload() {
    try {
      setData(await fetchProfiles());
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof Error ? err.message : "Failed to load profiles",
      });
    }
  }

  useEffect(() => {
    reload();
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, []);

  async function handleDelete(id: string) {
    if (!confirm(`Delete profile "${id}"? This permanently removes the saved cookies and storage. This cannot be undone.`)) return;
    setBusy(id);
    try {
      await deleteProfile(id);
      setMessage({ type: "success", text: `Deleted ${id}` });
      await reload();
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof Error ? err.message : "Delete failed",
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleImport(file: File) {
    setBusy("__import__");
    try {
      const result = await importProfile(file);
      setMessage({ type: "success", text: `Imported ${result.imported} (${result.bytes} bytes)` });
      await reload();
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof Error ? err.message : "Import failed",
      });
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const enabled = data?.enabled ?? true;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Profiles</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Encrypted snapshots of browser cookies and per-origin storage. Saved automatically when a session ends, replayed on the next session that connects with the same id.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {data && enabled && (
            <span className="text-sm font-mono text-muted-foreground tabular-nums">
              {data.count} total
            </span>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".bgp,application/octet-stream"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleImport(f);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null || !enabled}
            title={enabled ? "Upload an encrypted .bgp file exported from this gateway" : "Profiles feature is disabled"}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="size-3.5 mr-1.5" />
            Import
          </Button>
          {enabled && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleDisableProfiles}
              disabled={busy !== null || restartNotice !== null}
              title="Disable profiles in gateway.yml. Restart required."
            >
              <Power className="size-3.5 mr-1.5" />
              Disable
            </Button>
          )}
          {enabled && <NewProfileDialog authEnabled onCreated={reload} />}
        </div>
      </div>
      {restartNotice && <RestartNotice message={restartNotice} />}


      {message && (
        <div
          className={`text-[13px] px-3 py-2 rounded border ${
            message.type === "error"
              ? "bg-destructive/10 border-destructive/40 text-destructive-foreground"
              : "bg-muted/40 border-border text-foreground"
          }`}
        >
          {message.text}
        </div>
      )}

      {!enabled && (
        <Card className="glass border-border/40">
          <CardContent className="py-4 space-y-4">
            <div className="flex items-start gap-3">
              <Info className="size-4 text-muted-foreground shrink-0 mt-0.5" />
              <div className="space-y-1 text-sm">
                <p className="font-medium">Profiles are not enabled on this gateway</p>
                <p className="text-muted-foreground text-[13px]">
                  Profiles save cookies and per-origin storage between sessions, encrypted at rest. Click <em className="not-italic font-medium text-foreground">Enable Profiles</em> to generate an encryption key and apply the config.
                </p>
              </div>
            </div>
            <div>
              <SetupEncryptionKeyDialog />
            </div>
            <p className="text-[11px] text-muted-foreground">
              The wizard generates a strong key in your browser. Choose to apply it automatically (writes <code className="font-mono text-foreground/80 bg-muted px-1 py-0.5 rounded text-[10.5px]">.env</code> + <code className="font-mono text-foreground/80 bg-muted px-1 py-0.5 rounded text-[10.5px]">gateway.yml</code>) or copy the snippets and do it manually. Restart the gateway afterwards.
            </p>
          </CardContent>
        </Card>
      )}

      {enabled && (
        <Card className="glass border-border/40">
          <CardContent className={introOpen ? "py-3" : "py-1"}>
            <button
              onClick={() => setIntroOpen((v) => !v)}
              className="flex items-center justify-between w-full py-2 px-1 group"
              aria-expanded={introOpen}
              aria-controls="profiles-howto"
            >
              <div className="flex items-center gap-2">
                <Info className="size-4 text-muted-foreground" />
                <span className="text-[13px] font-medium text-foreground">
                  How profiles work + quick start examples
                </span>
              </div>
              {introOpen ? (
                <ChevronDown className="size-4 text-muted-foreground group-hover:text-foreground transition-colors" />
              ) : (
                <ChevronRight className="size-4 text-muted-foreground group-hover:text-foreground transition-colors" />
              )}
            </button>
            {introOpen && (
              <div id="profiles-howto" className="pt-2 pl-6 text-[13px] text-muted-foreground space-y-3">
                <p>
                  <span className="text-foreground font-medium">How it works.</span>{" "}
                  Connect with{" "}
                  <code className="bg-muted px-1.5 py-0.5 rounded text-[12px] text-foreground">?profile=&lt;id&gt;</code>{" "}
                  on the WebSocket URL. The gateway captures cookies and per-origin storage when your session ends, and replays them on the next connection with the same id. Profiles are encrypted at rest with your{" "}
                  <code className="bg-muted px-1.5 py-0.5 rounded text-[12px] text-foreground">BG_ENCRYPTION_KEY</code>{" "}
                  using AES-256-GCM.
                </p>
                <p>
                  <span className="text-foreground font-medium">Create.</span>{" "}
                  Click <em className="not-italic font-medium text-foreground">+ New Profile</em> at the top to generate a connect URL with a new id, or connect with any new <code className="bg-muted px-1.5 py-0.5 rounded text-[11px] text-foreground">?profile=&lt;id&gt;</code>. The blob is created on first disconnect.{" "}
                  <span className="text-foreground font-medium">Rename.</span>{" "}
                  Not currently supported; the id is bound into the encryption (anti-swap). To rename, export, then import as a new id and delete the original.{" "}
                  <span className="text-foreground font-medium">Password.</span>{" "}
                  One global key (BG_ENCRYPTION_KEY) protects every profile via envelope encryption.
                </p>
                <div className="pt-1">
                  <p className="text-foreground/90 font-medium text-[12px] mb-2">
                    Quick start by client
                  </p>
                  <IntegrationTabs authEnabled />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="glass overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-[11px] uppercase tracking-wider h-9">Profile</TableHead>
                <TableHead className="text-[11px] uppercase tracking-wider h-9">Updated</TableHead>
                <TableHead className="text-[11px] uppercase tracking-wider h-9 text-right">Size</TableHead>
                <TableHead className="text-[11px] uppercase tracking-wider h-9 text-right">DEK</TableHead>
                <TableHead className="text-[11px] uppercase tracking-wider h-9 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!data ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="text-center text-[13px] text-muted-foreground py-12">
                    Loading...
                  </TableCell>
                </TableRow>
              ) : data.count === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="text-center py-12">
                    <div className="space-y-2 max-w-md mx-auto">
                      <p className="text-[13px] text-muted-foreground">
                        No profiles saved yet.
                      </p>
                      {enabled && (
                        <p className="text-[12px] text-muted-foreground/80">
                          Connect with{" "}
                          <code className="bg-muted px-1.5 py-0.5 rounded text-[11px] text-foreground">?profile=&lt;id&gt;</code>{" "}
                          on the WebSocket URL. One will be created automatically when your session ends.
                        </p>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                data.profiles.map((p) => (
                  <TableRow key={p.id} className="hover:bg-muted/30">
                    <TableCell className="font-mono text-[13px]">{p.id}</TableCell>
                    <TableCell className="text-[12px] text-muted-foreground">
                      {formatWhen(p.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[12px] tabular-nums">
                      <span
                        className={p.sizeBytes > 5 * 1024 * 1024 ? "text-foreground" : ""}
                        title={
                          p.sizeBytes > 5 * 1024 * 1024
                            ? `Above 5 MB soft-warn threshold. The lifecycle evicts the oldest origins above 50 MB.`
                            : undefined
                        }
                      >
                        {formatBytes(p.sizeBytes)}
                        {p.sizeBytes > 5 * 1024 * 1024 && (
                          <span className="ml-1.5 inline-flex items-center rounded-sm bg-muted px-1 py-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                            large
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant="secondary"
                        className="font-mono text-[10px] h-5 px-1.5 font-normal"
                        title="Data encryption key version this profile was encrypted with"
                      >
                        v{p.dekVersion}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => handleCopyUrl(p.id)}
                          title={`Copy the WebSocket URL to use ${p.id} from your code`}
                        >
                          {copiedId === p.id ? (
                            <><Check className="size-3.5 mr-1.5" />Copied</>
                          ) : (
                            <><Copy className="size-3.5 mr-1.5" />Copy WS URL</>
                          )}
                        </Button>
                        <a
                          href={exportProfileUrl(p.id)}
                          download
                          title={`Export ${p.id} as an encrypted .bgp file`}
                        >
                          <Button variant="ghost" size="sm" disabled={busy !== null} aria-label="Export">
                            <Download className="size-3.5" />
                          </Button>
                        </a>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => handleDelete(p.id)}
                          title={`Delete ${p.id} (permanent)`}
                          aria-label="Delete"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
