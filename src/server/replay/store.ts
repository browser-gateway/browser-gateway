import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  ReplayDetail,
  ReplayFrameRecord,
  ReplayMeta,
  ReplayTargetSummary,
} from "./types.js";

const META_FILE = "meta.json";
const COMPLETE_FILE = "complete.json";
const TARGETS_DIR = "targets";
const MANIFEST_FILE = "manifest.jsonl";

export interface ListOpts {
  sinceMs?: number;
  limit?: number;
}

export class ReplayStore {
  constructor(private readonly storePath: string) {}

  exists(): boolean {
    return existsSync(this.storePath);
  }

  list(opts: ListOpts = {}): ReplayMeta[] {
    if (!existsSync(this.storePath)) return [];
    const limit = opts.limit ?? 100;
    const sinceMs = opts.sinceMs ?? 0;

    const entries: ReplayMeta[] = [];
    for (const sessionId of readdirSync(this.storePath)) {
      const meta = this.readMeta(sessionId);
      if (!meta) continue;
      if (meta.startedAt < sinceMs) continue;
      entries.push(meta);
    }
    entries.sort((a, b) => b.startedAt - a.startedAt);
    return entries.slice(0, limit);
  }

  get(sessionId: string): ReplayDetail | null {
    const meta = this.readMeta(sessionId);
    if (!meta) return null;

    const targetsDir = join(this.storePath, sessionId, TARGETS_DIR);
    const targets: ReplayTargetSummary[] = [];
    if (existsSync(targetsDir)) {
      for (const targetId of readdirSync(targetsDir)) {
        const summary = this.summarizeTarget(sessionId, targetId);
        if (summary) targets.push(summary);
      }
    }
    return { ...meta, targets };
  }

  framePath(sessionId: string, targetId: string, frame: number, ext: "png" | "jpeg" = "png"): string {
    const padded = String(frame).padStart(6, "0");
    return join(this.storePath, sessionId, TARGETS_DIR, targetId, `${padded}.${ext}`);
  }

  manifestPath(sessionId: string, targetId: string): string {
    return join(this.storePath, sessionId, TARGETS_DIR, targetId, MANIFEST_FILE);
  }

  readManifest(sessionId: string, targetId: string): ReplayFrameRecord[] {
    const path = this.manifestPath(sessionId, targetId);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((line) => JSON.parse(line) as ReplayFrameRecord);
  }

  delete(sessionId: string): void {
    const dir = join(this.storePath, sessionId);
    rmSync(dir, { recursive: true, force: true });
  }

  sessionSizeBytes(sessionId: string): number {
    const dir = join(this.storePath, sessionId);
    if (!existsSync(dir)) return 0;
    return walkDirSize(dir);
  }

  private readMeta(sessionId: string): ReplayMeta | null {
    const sessionDir = join(this.storePath, sessionId);
    const metaPath = join(sessionDir, META_FILE);
    if (!existsSync(metaPath)) return null;
    let raw: ReplayMeta;
    try {
      raw = JSON.parse(readFileSync(metaPath, "utf8")) as ReplayMeta;
    } catch {
      return null;
    }
    const completePath = join(sessionDir, COMPLETE_FILE);
    if (existsSync(completePath)) {
      try {
        const done = JSON.parse(readFileSync(completePath, "utf8")) as Partial<ReplayMeta>;
        return { ...raw, ...done, complete: true };
      } catch {
        return { ...raw, complete: true };
      }
    }
    return { ...raw, complete: false };
  }

  private summarizeTarget(sessionId: string, targetId: string): ReplayTargetSummary | null {
    const targetDir = join(this.storePath, sessionId, TARGETS_DIR, targetId);
    if (!existsSync(targetDir)) return null;
    const records = this.readManifest(sessionId, targetId);
    return {
      targetId,
      frameCount: records.length,
      sizeBytes: walkDirSize(targetDir),
      firstUrl: records[0]?.url,
      lastUrl: records[records.length - 1]?.url,
    };
  }
}

function walkDirSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += walkDirSize(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}
