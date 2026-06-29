import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, createReadStream, statSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { Logger } from "pino";
import type { ReplayFrameRecord } from "./types.js";
import type { ReplayStore } from "./store.js";

const FFMPEG_STATIC_VERSION = "5.3.0";

export class FfmpegMissingError extends Error {
  constructor() {
    super("ffmpeg not found");
    this.name = "FfmpegMissingError";
  }
}

export class NoFramesError extends Error {
  constructor() {
    super("No frames captured for this target");
    this.name = "NoFramesError";
  }
}

export class FfmpegInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FfmpegInstallError";
  }
}

function localFfmpegPath(dataDir: string): string {
  const binName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return join(dataDir, ".npm", "node_modules", "ffmpeg-static", binName);
}

async function spawnCheck(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(cmd, args, { stdio: "ignore" });
      proc.on("error", () => resolve(false));
      proc.on("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

function runProcess(cmd: string, args: string[], opts: { onError: (code: number | null, stderr: string) => Error }): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(opts.onError(code, stderr));
    });
  });
}

export async function findFfmpegBinary(dataDir: string): Promise<string | null> {
  if (await spawnCheck("ffmpeg", ["-version"])) return "ffmpeg";
  const local = localFfmpegPath(dataDir);
  if (existsSync(local) && (await spawnCheck(local, ["-version"]))) return local;
  return null;
}

export async function isFfmpegStaticInstalled(dataDir: string): Promise<boolean> {
  return existsSync(localFfmpegPath(dataDir));
}

export async function installFfmpegStatic(opts: { dataDir: string; logger: Logger }): Promise<void> {
  const installDir = join(opts.dataDir, ".npm");
  mkdirSync(installDir, { recursive: true });

  if (!(await spawnCheck("npm", ["--version"]))) {
    throw new FfmpegInstallError("npm is not available on PATH — install ffmpeg via your system package manager instead");
  }

  await runProcess(
    "npm",
    ["install", `ffmpeg-static@${FFMPEG_STATIC_VERSION}`, "--prefix", installDir, "--no-save", "--no-audit", "--no-fund", "--loglevel=error"],
    {
      onError: (code, stderr) => {
        opts.logger.warn({ code, stderr: stderr.slice(0, 500) }, "ffmpeg-static install failed");
        return new FfmpegInstallError(`npm install ffmpeg-static exited ${code}: ${stderr.slice(0, 200)}`);
      },
    },
  );

  const path = localFfmpegPath(opts.dataDir);
  if (!existsSync(path)) {
    throw new FfmpegInstallError("npm install completed but ffmpeg-static binary not found at expected path");
  }
}

export interface ExportResult {
  outputPath: string;
  cleanup: () => void;
  sizeBytes: number;
  readStream: Readable;
}

export async function exportTargetAsMp4(opts: {
  store: ReplayStore;
  sessionId: string;
  targetId: string;
  format: "png" | "jpeg";
  dataDir: string;
  logger: Logger;
}): Promise<ExportResult> {
  const { store, sessionId, targetId, format, dataDir, logger } = opts;

  const ffmpegBin = await findFfmpegBinary(dataDir);
  if (!ffmpegBin) throw new FfmpegMissingError();

  const records = store.readManifest(sessionId, targetId);
  if (records.length === 0) throw new NoFramesError();

  const tmpDir = mkdtempSync(join(tmpdir(), "bg-replay-export-"));
  const cleanup = () => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  };

  try {
    const concatPath = join(tmpDir, "frames.txt");
    writeConcatFile(concatPath, records, store, sessionId, targetId, format);

    const outputPath = join(tmpDir, "replay.mp4");
    await runFfmpeg({ ffmpegBin, concatPath, outputPath, logger });

    if (!existsSync(outputPath)) {
      throw new Error("ffmpeg ran but produced no output");
    }
    const sizeBytes = statSync(outputPath).size;
    const readStream = createReadStream(outputPath);
    readStream.on("close", cleanup);
    readStream.on("error", cleanup);
    return { outputPath, cleanup, sizeBytes, readStream };
  } catch (err) {
    cleanup();
    throw err;
  }
}

function writeConcatFile(
  concatPath: string,
  records: ReplayFrameRecord[],
  store: ReplayStore,
  sessionId: string,
  targetId: string,
  format: "png" | "jpeg",
): void {
  const lines: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const cur = records[i];
    const next = records[i + 1];
    const durationSec = next ? Math.max(0.02, (next.ts - cur.ts) / 1000) : 0.1;
    const framePath = store.framePath(sessionId, targetId, cur.frame, format);
    lines.push(`file '${framePath.replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${durationSec.toFixed(3)}`);
  }
  const lastPath = store.framePath(sessionId, targetId, records[records.length - 1].frame, format);
  lines.push(`file '${lastPath.replace(/'/g, "'\\''")}'`);
  writeFileSync(concatPath, lines.join("\n") + "\n");
}

function runFfmpeg(opts: { ffmpegBin: string; concatPath: string; outputPath: string; logger: Logger }): Promise<void> {
  return runProcess(
    opts.ffmpegBin,
    [
      "-y",
      "-loglevel", "error",
      "-f", "concat",
      "-safe", "0",
      "-i", opts.concatPath,
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v", "libx264",
      "-preset", "fast",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      opts.outputPath,
    ],
    {
      onError: (code, stderr) => {
        opts.logger.warn({ code, stderr: stderr.slice(0, 500) }, "replay export: ffmpeg failed");
        return new Error(`ffmpeg exited with code ${code}: ${stderr.slice(0, 200)}`);
      },
    },
  );
}
