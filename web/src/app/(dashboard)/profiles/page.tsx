"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Trash2, Upload } from "lucide-react";
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
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    if (!confirm(`Delete profile "${id}"? This cannot be undone.`)) return;
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

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Profiles</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Saved browser profiles (cookies + state) used by sessions that connect with{" "}
            <code className="text-[12px] bg-muted px-1 py-0.5 rounded">?profile=&lt;id&gt;</code>.
            Profiles are encrypted at rest with your BG_ENCRYPTION_KEY.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {data && (
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
            disabled={busy !== null}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="size-3.5 mr-1.5" />
            Import
          </Button>
        </div>
      </div>

      {message && (
        <div
          className={`text-[13px] px-3 py-2 rounded border ${
            message.type === "error"
              ? "bg-red-500/10 border-red-500/30 text-red-200"
              : "bg-emerald-500/10 border-emerald-500/30 text-emerald-200"
          }`}
        >
          {message.text}
        </div>
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
              {!data || data.count === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="text-center text-[13px] text-muted-foreground py-12">
                    {data ? "No profiles saved yet — connect with ?profile=<id> to create one" : "Loading..."}
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
                      {formatBytes(p.sizeBytes)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant="secondary" className="font-mono text-[10px] h-5 px-1.5 font-normal">
                        v{p.dekVersion}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <a href={exportProfileUrl(p.id)} download>
                          <Button variant="ghost" size="sm" disabled={busy !== null}>
                            <Download className="size-3.5" />
                          </Button>
                        </a>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => handleDelete(p.id)}
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
