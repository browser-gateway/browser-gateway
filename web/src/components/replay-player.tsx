"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReplayFrameRecord } from "@/lib/api";
import { fetchReplayManifest, replayFrameUrl } from "@/lib/api";

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
    const delay = Math.max(20, next.ts - cur.ts);
    timerRef.current = setTimeout(() => setFrameIdx((i) => i + 1), delay);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [playing, frameIdx, manifest, timeline]);

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
      <div className="overflow-hidden rounded-md border border-border bg-muted/30">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={frameUrl}
          src={frameUrl}
          alt={`Frame ${current.frame}`}
          className="block w-full"
          style={{ aspectRatio: current.deviceWidth && current.deviceHeight ? `${current.deviceWidth} / ${current.deviceHeight}` : undefined }}
        />
      </div>

      <div className="flex items-center gap-3">
        <Button size="icon" variant="ghost" onClick={() => setFrameIdx(0)} aria-label="Go to start">
          <ChevronsLeft className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>
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
    </div>
  );
}
