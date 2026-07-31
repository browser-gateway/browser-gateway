import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ReplayConfig } from "../../core/types.js";
import type { CdpEvent } from "../live/cdp-client.js";
import { CdpClient } from "../live/cdp-client.js";
import type { ReplayFrameRecord, ReplayManifest, ReplayMeta } from "./types.js";

export interface ReplayCaptureOpts {
  sessionId: string;
  providerId: string;
  providerWsUrl: string;
  profileId?: string;
  storePath: string;
  config: ReplayConfig;
  logger: Logger;
}

interface TargetState {
  targetId: string;
  attachSessionId: string;
  frameCount: number;
  sizeBytes: number;
  lastUrl?: string;
  lastFrameHash?: string;
}

const QUEUE_MAX = 200;
const CHUNK_MAX_BYTES = 25 * 1024 * 1024;
const CHUNK_MAX_ELAPSED_MS = 5 * 60 * 1000;

export class ReplayCapture {
  private readonly cdp = new CdpClient();
  private readonly sessionDir: string;
  private readonly partsDir: string;
  private readonly targets = new Map<string, TargetState>();
  private readonly frames: ReplayFrameRecord[] = [];
  private writeQueue = 0;
  private droppedFrames = 0;
  private duplicatesSkipped = 0;
  private totalBytes = 0;
  private capStopped = false;
  private cleanupFns: Array<() => void> = [];
  private chunkIndex = 0;
  private chunkBuffer: Buffer[] = [];
  private chunkBufferBytes = 0;
  private chunkOpenedAt = 0;

  constructor(private readonly opts: ReplayCaptureOpts) {
    this.sessionDir = join(opts.storePath, opts.sessionId);
    this.partsDir = join(this.sessionDir, "parts");
  }

  async start(): Promise<void> {
    mkdirSync(this.sessionDir, { recursive: true });
    mkdirSync(this.partsDir, { recursive: true });

    const meta: ReplayMeta = {
      sessionId: this.opts.sessionId,
      providerId: this.opts.providerId,
      profileId: this.opts.profileId,
      startedAt: Date.now(),
      frameCount: 0,
      sizeBytes: 0,
      complete: false,
      format: this.opts.config.capture.format,
    };
    writeFileSync(join(this.sessionDir, "meta.json"), JSON.stringify(meta));
    this.chunkOpenedAt = Date.now();

    try {
      await this.cdp.connect(this.opts.providerWsUrl, 10_000);
    } catch (err) {
      this.opts.logger.warn(
        { sessionId: this.opts.sessionId, err: errMsg(err) },
        "replay: cdp connect failed, capture disabled for this session",
      );
      return;
    }

    const offEvent = this.cdp.on((event) => this.handleEvent(event));
    this.cleanupFns.push(offEvent);

    const offClose = this.cdp.onClose(() => {
      this.opts.logger.debug({ sessionId: this.opts.sessionId }, "replay: cdp closed");
    });
    this.cleanupFns.push(offClose);

    this.cdp.sendMayFail("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });

    try {
      const list = await this.cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>(
        "Target.getTargets",
      );
      for (const ti of list.targetInfos) {
        if (ti.type === "page" || ti.type === "iframe") {
          this.attachToTarget(ti.targetId).catch((err) =>
            this.opts.logger.debug({ targetId: ti.targetId, err: errMsg(err) }, "replay: attach failed"),
          );
        }
      }
    } catch (err) {
      this.opts.logger.debug({ err: errMsg(err) }, "replay: getTargets failed");
    }
  }

  async finish(): Promise<{ frameCount: number; sizeBytes: number; droppedFrames: number; duplicatesSkipped: number }> {
    const alreadyStopped = this.capStopped;
    this.capStopped = true;

    for (const target of this.targets.values()) {
      this.cdp.sendMayFail("Page.stopScreencast", {}, target.attachSessionId);
    }

    for (const off of this.cleanupFns) off();
    this.cleanupFns = [];

    while (this.writeQueue > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }

    this.cdp.close();

    if (!alreadyStopped) {
      this.flushChunk();
      this.writeManifest();
    }

    const totalFrames = this.frames.length;

    const endedAt = Date.now();
    try {
      writeFileSync(
        join(this.sessionDir, "complete.json"),
        JSON.stringify({
          endedAt,
          frameCount: totalFrames,
          sizeBytes: this.totalBytes,
          droppedFrames: this.droppedFrames,
          duplicatesSkipped: this.duplicatesSkipped,
        }),
      );
    } catch (err) {
      this.opts.logger.warn({ err: errMsg(err) }, "replay: failed to write complete.json");
    }

    return { frameCount: totalFrames, sizeBytes: this.totalBytes, droppedFrames: this.droppedFrames, duplicatesSkipped: this.duplicatesSkipped };
  }

  private async attachToTarget(targetId: string): Promise<void> {
    if (this.targets.has(targetId)) return;
    if (this.capStopped) return;

    let attachSessionId: string;
    try {
      const r = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      attachSessionId = r.sessionId;
    } catch (err) {
      this.opts.logger.debug({ targetId, err: errMsg(err) }, "replay: attach failed");
      return;
    }

    const state: TargetState = {
      targetId,
      attachSessionId,
      frameCount: 0,
      sizeBytes: 0,
    };
    this.targets.set(targetId, state);

    this.cdp.sendMayFail("Page.enable", {}, attachSessionId);

    this.cdp.sendMayFail(
      "Page.startScreencast",
      {
        format: this.opts.config.capture.format,
        quality: this.opts.config.capture.quality,
        everyNthFrame: this.opts.config.capture.everyNthFrame,
      },
      attachSessionId,
    );
  }

  private handleEvent(event: CdpEvent): void {
    if (event.method === "Target.attachedToTarget") {
      const params = event.params as { sessionId?: string; targetInfo?: { targetId: string; type: string } };
      const ti = params.targetInfo;
      if (ti && (ti.type === "page" || ti.type === "iframe")) {
        this.attachToTarget(ti.targetId).catch((err) =>
          this.opts.logger.debug({ targetId: ti.targetId, err: errMsg(err) }, "replay: auto-attach failed"),
        );
      }
      return;
    }

    if (event.method === "Target.detachedFromTarget") {
      const params = event.params as { sessionId?: string };
      for (const [, target] of this.targets) {
        if (target.attachSessionId === params.sessionId) {
          this.targets.delete(target.targetId);
          break;
        }
      }
      return;
    }

    if (event.method === "Page.frameNavigated") {
      const params = event.params as { frame?: { url?: string; parentId?: string } };
      const target = this.targetForSession(event.sessionId);
      if (target && params.frame && !params.frame.parentId && params.frame.url) {
        target.lastUrl = params.frame.url;
      }
      return;
    }

    if (event.method === "Page.screencastFrame") {
      this.handleScreencastFrame(event);
      return;
    }
  }

  private handleScreencastFrame(event: CdpEvent): void {
    const target = this.targetForSession(event.sessionId);
    if (!target) return;

    const params = event.params as {
      data: string;
      sessionId: number;
      metadata?: {
        timestamp?: number;
        deviceWidth?: number;
        deviceHeight?: number;
        scrollOffsetX?: number;
        scrollOffsetY?: number;
      };
    };

    this.cdp.sendMayFail("Page.screencastFrameAck", { sessionId: params.sessionId }, target.attachSessionId);

    if (this.totalBytes >= this.opts.config.maxBytesPerSession) {
      if (!this.capStopped) {
        this.opts.logger.warn(
          { sessionId: this.opts.sessionId, totalBytes: this.totalBytes },
          "replay: per-session byte cap reached, stopping capture",
        );
        this.capStopped = true;
        for (const t of this.targets.values()) {
          this.cdp.sendMayFail("Page.stopScreencast", {}, t.attachSessionId);
        }
      }
      return;
    }

    if (this.writeQueue >= QUEUE_MAX) {
      this.droppedFrames++;
      return;
    }

    const buf = Buffer.from(params.data, "base64");
    const hash = createHash("sha1").update(buf).digest("hex");
    if (target.lastFrameHash === hash) {
      this.duplicatesSkipped++;
      return;
    }
    target.lastFrameHash = hash;

    this.writeQueue++;
    try {
      this.appendFrameToBuffer(target, buf, params.metadata ?? {});
    } catch (err) {
      this.opts.logger.debug({ err: errMsg(err) }, "replay: append failed");
    } finally {
      this.writeQueue--;
    }
  }

  private appendFrameToBuffer(
    target: TargetState,
    buf: Buffer,
    metadata: {
      timestamp?: number;
      deviceWidth?: number;
      deviceHeight?: number;
      scrollOffsetX?: number;
      scrollOffsetY?: number;
    },
  ): void {
    const frameNumber = this.frames.length + 1;
    const byteOffset = this.chunkBufferBytes;

    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32BE(buf.length, 0);
    this.chunkBuffer.push(lenPrefix, buf);
    this.chunkBufferBytes += 4 + buf.length;

    this.frames.push({
      frame: frameNumber,
      ts: typeof metadata.timestamp === "number" ? metadata.timestamp * 1000 : Date.now(),
      url: target.lastUrl ?? "",
      deviceWidth: metadata.deviceWidth ?? 0,
      deviceHeight: metadata.deviceHeight ?? 0,
      scrollX: metadata.scrollOffsetX ?? 0,
      scrollY: metadata.scrollOffsetY ?? 0,
      sizeBytes: buf.length,
      targetId: target.targetId,
      chunkIndex: this.chunkIndex,
      byteOffset,
      length: buf.length,
    });

    target.frameCount++;
    target.sizeBytes += buf.length;
    this.totalBytes += buf.length;

    const elapsed = Date.now() - this.chunkOpenedAt;
    if (this.chunkBufferBytes >= CHUNK_MAX_BYTES || elapsed >= CHUNK_MAX_ELAPSED_MS) {
      this.flushChunk();
    }
  }

  private flushChunk(): void {
    if (this.chunkBufferBytes === 0) return;
    const partPath = join(this.partsDir, `${String(this.chunkIndex).padStart(3, "0")}.bin`);
    try {
      writeFileSync(partPath, Buffer.concat(this.chunkBuffer));
    } catch (err) {
      this.opts.logger.warn({ err: errMsg(err), partPath }, "replay: chunk flush failed");
    }
    this.chunkBuffer = [];
    this.chunkBufferBytes = 0;
    this.chunkIndex++;
    this.chunkOpenedAt = Date.now();
  }

  private writeManifest(): void {
    const manifest: ReplayManifest = {
      sessionId: this.opts.sessionId,
      format: this.opts.config.capture.format,
      targets: Array.from(this.targets.keys()),
      frames: this.frames,
    };
    try {
      writeFileSync(join(this.sessionDir, "manifest.json"), JSON.stringify(manifest));
    } catch (err) {
      this.opts.logger.warn({ err: errMsg(err) }, "replay: manifest write failed");
    }
  }

  private targetForSession(cdpSessionId: string | undefined): TargetState | null {
    if (!cdpSessionId) return null;
    for (const target of this.targets.values()) {
      if (target.attachSessionId === cdpSessionId) return target;
    }
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
