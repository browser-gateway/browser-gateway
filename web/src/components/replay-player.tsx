"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, ChevronsLeft, ChevronsRight, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReplayFrameRecord } from "@/lib/api";
import { fetchReplayManifest, installFfmpegStatic, replayFrameUrl, replayMp4ExportUrl } from "@/lib/api";

interface ReplayPlayerProps {
  sessionId: string;
  targetId: string;
  format: "png" | "jpeg";
}

function formatHms(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ReplayPlayer({ sessionId, targetId, format }: ReplayPlayerProps) {
  const [manifest, setManifest] = useState<ReplayFrameRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setManifest(null);
    setError(null);
    setFrameIdx(0);
    setPlaying(false);
    fetchReplayManifest(sessionId, targetId).then(
      (m) => { if (!cancelled) setManifest(m); },
      (e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { cancelled = true; };
  }, [sessionId, targetId]);

  const timeline = useMemo(() => {
    if (!manifest || manifest.length === 0) return null;
    const startTs = manifest[0].ts;
    const totalMs = manifest[manifest.length - 1].ts - startTs;
    return { startTs, totalMs };
  }, [manifest]);

  useEffect(() => {
    if (!playing || !manifest || !timeline) return;
    if (frameIdx >= manifest.length - 1) { setPlaying(false); return; }
    const cur = manifest[frameIdx];
    const next = manifest[frameIdx + 1];
    const delay = Math.min(2000, Math.max(20, next.ts - cur.ts));
    timerRef.current = setTimeout(() => setFrameIdx((i) => i + 1), delay);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [playing, frameIdx, manifest, timeline]);

  function togglePlay() {
    if (!manifest || manifest.length === 0) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    if (frameIdx >= manifest.length - 1) {
      setFrameIdx(0);
    }
    setPlaying(true);
  }

  if (error) {
    return (
      <div className="rounded-md border border-border bg-muted/30 p-6 text-sm text-muted-foreground">
        Failed to load manifest: {error}
      </div>
    );
  }
  if (!manifest) {
    return (
      <div className="rounded-md border border-border bg-muted/30 p-6 text-sm text-muted-foreground">
        Loading replay...
      </div>
    );
  }
  if (manifest.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/30 p-6 text-sm text-muted-foreground">
        No frames captured on this target.
      </div>
    );
  }

  const current = manifest[frameIdx];
  const frameUrl = replayFrameUrl(sessionId, targetId, current.frame, format);
  const elapsedMs = current.ts - manifest[0].ts;
  const totalMs = timeline ? timeline.totalMs : 0;

  return (
    <div className="space-y-3">
      <div
        className="overflow-hidden rounded-md border border-border bg-muted/30"
        style={{ aspectRatio: current.deviceWidth && current.deviceHeight ? `${current.deviceWidth} / ${current.deviceHeight}` : undefined }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={frameUrl}
          alt={`Frame ${current.frame}`}
          className="block w-full h-full"
        />
      </div>

      <div className="flex items-center gap-3">
        <Button size="icon" variant="ghost" onClick={() => setFrameIdx(0)} aria-label="Go to start">
          <ChevronsLeft className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <Button size="icon" variant="ghost" onClick={() => setFrameIdx(manifest.length - 1)} aria-label="Go to end">
          <ChevronsRight className="size-4" />
        </Button>
        <input
          type="range"
          min={0}
          max={manifest.length - 1}
          value={frameIdx}
          onChange={(e) => { setPlaying(false); setFrameIdx(parseInt(e.target.value, 10)); }}
          className="flex-1 accent-foreground"
          aria-label="Scrub timeline"
        />
        <div className="font-mono text-xs text-muted-foreground tabular-nums">
          {formatHms(elapsedMs)} / {formatHms(totalMs)}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
        <div>Frame <span className="text-foreground tabular-nums">{current.frame} / {manifest.length}</span></div>
        <div>Viewport <span className="text-foreground tabular-nums">{current.deviceWidth}x{current.deviceHeight}</span></div>
        <div>Scroll <span className="text-foreground tabular-nums">{current.scrollX}, {current.scrollY}</span></div>
        <div className="truncate">URL <span className="text-foreground" title={current.url}>{current.url || "—"}</span></div>
      </div>

      <div>
        <ExportMp4Button sessionId={sessionId} targetId={targetId} />
      </div>
    </div>
  );
}

type ExportPhase = "idle" | "encoding" | "needs-ffmpeg" | "installing" | "error";

function ExportMp4Button({ sessionId, targetId }: { sessionId: string; targetId: string }) {
  const [phase, setPhase] = useState<ExportPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [installHints, setInstallHints] = useState<Record<string, string> | null>(null);

  async function downloadMp4(): Promise<"ok" | "missing"> {
    const url = replayMp4ExportUrl(sessionId, targetId);
    const res = await fetch(url, { credentials: "include" });
    if (res.status === 503) {
      const body = await res.json() as { install?: Record<string, string> };
      setInstallHints(body.install ?? null);
      return "missing";
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Export failed: ${res.status}`);
    }
    const blob = await res.blob();
    const dl = document.createElement("a");
    dl.href = URL.createObjectURL(blob);
    dl.download = `replay-${sessionId.slice(0, 8)}-${targetId.slice(0, 8)}.mp4`;
    document.body.appendChild(dl);
    dl.click();
    dl.remove();
    URL.revokeObjectURL(dl.href);
    return "ok";
  }

  async function handleExport() {
    setError(null);
    setInstallHints(null);
    setPhase("encoding");
    try {
      const r = await downloadMp4();
      setPhase(r === "missing" ? "needs-ffmpeg" : "idle");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  async function handleAutoInstall() {
    setPhase("installing");
    setError(null);
    try {
      await installFfmpegStatic();
      setPhase("encoding");
      const r = await downloadMp4();
      setPhase(r === "missing" ? "needs-ffmpeg" : "idle");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  const busy = phase === "encoding" || phase === "installing";
  const buttonLabel = phase === "encoding" ? "Encoding..." : phase === "installing" ? "Installing ffmpeg..." : "Export as MP4";

  return (
    <div className="space-y-2">
      <Button variant="outline" size="sm" onClick={handleExport} disabled={busy} className="gap-2">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
        {buttonLabel}
      </Button>

      {phase === "needs-ffmpeg" && (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">ffmpeg is not installed on the gateway host.</p>
          <p>
            Install via npm (one-time, ~80 MB into <code className="font-mono text-foreground/80">$BG_DATA_DIR/.npm/</code>),
            or install ffmpeg on the host using your package manager.
          </p>
          <div className="pt-1">
            <Button variant="outline" size="sm" onClick={handleAutoInstall}>
              Install ffmpeg automatically
            </Button>
          </div>
          {installHints && (
            <pre className="whitespace-pre-wrap rounded-md border border-border bg-background/30 p-2 text-[11px] font-mono">
{`macOS:    ${installHints.macos ?? "brew install ffmpeg"}
Debian:   ${installHints.debian ?? "apt install ffmpeg"}
Fedora:   ${installHints.redhat ?? "dnf install ffmpeg"}
Windows:  ${installHints.windows ?? "https://ffmpeg.org/download.html"}`}
            </pre>
          )}
        </div>
      )}

      {phase === "error" && error && (
        <pre className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground font-mono">
          {error}
        </pre>
      )}
    </div>
  );
}
