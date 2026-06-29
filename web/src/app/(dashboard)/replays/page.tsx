"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Power, Trash2 } from "lucide-react";
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
import { ReplayPlayer } from "@/components/replay-player";
import { RestartNotice } from "@/components/restart-notice";
import type { ReplayDetail, ReplayListResponse } from "@/lib/api";
import { deleteReplay, disableReplays, enableReplays, fetchReplay, fetchReplays } from "@/lib/api";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(startMs: number, endMs?: number): string {
  if (!endMs) return "—";
  const sec = Math.floor((endMs - startMs) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function formatWhen(ms: number): string {
  const ageMs = Date.now() - ms;
  if (ageMs < 60_000) return "just now";
  if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 24 * 60 * 60_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return new Date(ms).toLocaleString();
}

function ReplaysList() {
  const [data, setData] = useState<ReplayListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchReplays().then(
      (r) => { if (!cancelled) setData(r); },
      (e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { cancelled = true; };
  }, []);

  async function handleEnable() {
    setToggling(true);
    try {
      const r = await enableReplays();
      setNotice(r.restartRequired ? "Replays enabled in gateway.yml." : null);
    } catch (e: unknown) {
      alert(`Enable failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setToggling(false);
    }
  }

  async function handleDisable() {
    if (!confirm("Disable replays? In-progress captures stop. Existing replays stay on disk.")) return;
    setToggling(true);
    try {
      const r = await disableReplays();
      setNotice(r.restartRequired ? "Replays disabled in gateway.yml." : null);
    } catch (e: unknown) {
      alert(`Disable failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setToggling(false);
    }
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">Failed to load: {error}</CardContent>
      </Card>
    );
  }
  if (!data) {
    return <Card><CardContent className="p-6 text-sm text-muted-foreground">Loading...</CardContent></Card>;
  }

  if (!data.enabled) {
    return (
      <div className="space-y-4">
        {notice && <RestartNotice message={notice} />}
        <Card>
          <CardContent className="space-y-4 p-6">
            <div>
              <h2 className="text-base font-semibold">Replays disabled</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {data.reason ?? "Replays are off. Enable to start capturing a frame-accurate visual record of every routed session."}
              </p>
            </div>
            <Button onClick={handleEnable} disabled={toggling || notice !== null} className="gap-2">
              <Power className="size-4" />
              {toggling ? "Enabling..." : "Enable Replays"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {notice && <RestartNotice message={notice} />}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{data.count} {data.count === 1 ? "replay" : "replays"} captured</p>
        <Button variant="outline" size="sm" onClick={handleDisable} disabled={toggling || notice !== null} className="gap-2">
          <Power className="size-4" />
          {toggling ? "Disabling..." : "Disable"}
        </Button>
      </div>
      {data.replays.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No replays yet. Route a session through a provider that supports page screencast and one will appear here.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Profile</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Frames</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.replays.map((r) => (
                  <TableRow key={r.sessionId} className="cursor-pointer hover:bg-muted/40">
                    <TableCell className="font-mono text-xs">
                      <Link href={`/replays/?session=${encodeURIComponent(r.sessionId)}`} className="hover:underline">
                        {r.sessionId.slice(0, 12)}
                      </Link>
                    </TableCell>
                    <TableCell>{r.providerId}</TableCell>
                    <TableCell className="font-mono text-xs">{r.profileId ?? "—"}</TableCell>
                    <TableCell className="tabular-nums">{formatDuration(r.startedAt, r.endedAt)}</TableCell>
                    <TableCell className="tabular-nums">{r.frameCount.toLocaleString()}</TableCell>
                    <TableCell className="tabular-nums">{formatBytes(r.sizeBytes)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatWhen(r.startedAt)}</TableCell>
                    <TableCell>
                      {r.complete ? <Badge variant="outline">Complete</Badge> : <Badge>Recording</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ReplayDetailView({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<ReplayDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTarget, setActiveTarget] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    fetchReplay(sessionId).then(
      (d) => {
        if (cancelled) return;
        setDetail(d);
        if (d && d.targets.length > 0) setActiveTarget(d.targets[0].targetId);
      },
      (e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { cancelled = true; };
  }, [sessionId]);

  async function handleDelete() {
    if (!confirm(`Delete replay ${sessionId}? This cannot be undone.`)) return;
    try {
      await deleteReplay(sessionId);
      router.push("/replays/");
    } catch (e: unknown) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (error) {
    return <Card><CardContent className="p-6 text-sm text-muted-foreground">Failed to load: {error}</CardContent></Card>;
  }
  if (!detail) {
    return <Card><CardContent className="p-6 text-sm text-muted-foreground">Loading replay...</CardContent></Card>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Link
          href="/replays/"
          className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[0.85rem] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to replays
        </Link>
        <Button variant="ghost" size="sm" onClick={handleDelete} className="gap-2 text-muted-foreground hover:text-destructive">
          <Trash2 className="size-4" />
          Delete
        </Button>
      </div>

      <Card>
        <CardContent className="space-y-4 p-6">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <div className="text-xs text-muted-foreground">Session</div>
              <div className="font-mono">{detail.sessionId}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Provider</div>
              <div>{detail.providerId}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Profile</div>
              <div className="font-mono">{detail.profileId ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Status</div>
              <div>{detail.complete ? "Complete" : "Recording"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Started</div>
              <div>{new Date(detail.startedAt).toLocaleString()}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Duration</div>
              <div className="tabular-nums">{formatDuration(detail.startedAt, detail.endedAt)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Frames</div>
              <div className="tabular-nums">{detail.frameCount.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Size</div>
              <div className="tabular-nums">{formatBytes(detail.sizeBytes)}</div>
            </div>
          </div>

          {detail.targets.length === 0 ? (
            <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
              No browser targets recorded for this session.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                {detail.targets.map((t) => (
                  <Button
                    key={t.targetId}
                    size="sm"
                    variant={activeTarget === t.targetId ? "default" : "outline"}
                    onClick={() => setActiveTarget(t.targetId)}
                    className="font-mono text-xs"
                  >
                    {t.targetId.slice(0, 8)} · {t.frameCount}
                  </Button>
                ))}
              </div>
              {activeTarget && (
                <ReplayPlayer sessionId={detail.sessionId} targetId={activeTarget} format={detail.format} />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ReplaysRouter() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session");
  if (sessionId) return <ReplayDetailView sessionId={sessionId} />;
  return <ReplaysList />;
}

export default function ReplaysPage() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Replays</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Frame-accurate visual record of every routed session.
        </p>
      </div>
      <Suspense fallback={<Card><CardContent className="p-6 text-sm text-muted-foreground">Loading...</CardContent></Card>}>
        <ReplaysRouter />
      </Suspense>
    </div>
  );
}
