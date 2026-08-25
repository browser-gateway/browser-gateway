import type {
  ReplayFrameRecord,
  ReplayManifest,
  ReplayMeta,
} from "../../server/replay/types.js";
import type { CdpMessage, CdpPlugin, SessionState } from "../types.js";
import { base64ToBytes } from "../socket-io.js";

/** Backing store the plugin writes chunked frames + metadata to. Isomorphic:
 *  Node fs impl lives in `src/server/replay/node-storage.ts`; a Workers R2
 *  impl can plug the same interface in later. */
export interface ReplayStorage {
  /** Called once at session start, before any writeChunk. */
  init(sessionId: string, meta: ReplayMeta): Promise<void>;
  /** Called per chunk rollover. `data` is the concatenated bytes of every
   *  frame in this chunk, each prefixed by a big-endian uint32 length header
   *  (4 bytes) — matches the on-disk format the OSS ReplayStore reader
   *  expects (`byteOffset + 4` skip). */
  writeChunk(sessionId: string, chunkIndex: number, data: Uint8Array): Promise<void>;
  /** Called once at session end. Persists the manifest + completion record. */
  finalize(
    sessionId: string,
    manifest: ReplayManifest,
    summary: {
      endedAt: number;
      frameCount: number;
      sizeBytes: number;
      droppedFrames: number;
      duplicatesSkipped: number;
    },
  ): Promise<void>;
}

export interface ScreencastCapturePluginOpts {
  sessionId: string;
  providerId: string;
  profileId?: string;
  storage: ReplayStorage;
  format: "png" | "jpeg";
  quality: number;
  everyNthFrame: number;
  maxBytesPerSession: number;
  chunkMaxBytes: number;
  chunkMaxElapsedMs: number;
  /** Cap on outstanding chunk writes; frames are dropped when exceeded. */
  maxInFlightChunks?: number;
  /** Viewport width for Page.setDeviceMetricsOverride. Required for
   *  Page.startScreencast to emit frames on stock Chromium — see
   *  puppeteer/puppeteer#10527. Defaults to 1280. */
  viewportWidth?: number;
  /** Viewport height for Page.setDeviceMetricsOverride. Defaults to 720. */
  viewportHeight?: number;
  /** Device scale factor for Page.setDeviceMetricsOverride. Defaults to 1. */
  deviceScaleFactor?: number;
  /** When true, drops frames whose `url` is the empty string (pre-navigation
   *  about:blank). Reduces manifest noise while the browser is booting. */
  filterEmptyUrl?: boolean;
  logger?: (msg: string, data?: Record<string, unknown>) => void;
}

interface TargetState {
  targetId: string;
  cdpSessionId: string;
  frameCount: number;
  sizeBytes: number;
  lastUrl?: string;
  lastFrameHash?: number;
}

interface CdpTargetInfo {
  targetId: string;
  type: string;
}

/** CDP screencast capture as a pipeline plugin. Rides the same CDP
 *  connection the client uses; no second WebSocket to the provider. */
export class ScreencastCapturePlugin implements CdpPlugin {
  readonly name = "screencast-capture";

  private readonly maxInFlight: number;
  private readonly targets = new Map<string, TargetState>();
  private readonly frames: ReplayFrameRecord[] = [];
  private droppedFrames = 0;
  private duplicatesSkipped = 0;
  private totalBytes = 0;
  private capStopped = false;
  private started = false;
  private chunkIndex = 0;
  private chunkBuffer: Uint8Array[] = [];
  private chunkBufferBytes = 0;
  private chunkOpenedAt = 0;
  private pendingWrites: Set<Promise<void>> = new Set();

  constructor(private readonly opts: ScreencastCapturePluginOpts) {
    this.maxInFlight = opts.maxInFlightChunks ?? 8;
  }

  async onSessionStart(state: SessionState): Promise<void> {
    const meta: ReplayMeta = {
      sessionId: this.opts.sessionId,
      providerId: this.opts.providerId,
      profileId: this.opts.profileId,
      startedAt: Date.now(),
      frameCount: 0,
      sizeBytes: 0,
      complete: false,
      format: this.opts.format,
    };
    await this.opts.storage.init(this.opts.sessionId, meta);
    this.chunkOpenedAt = Date.now();
    this.started = true;

    state.sendInternalOneWay("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    // Don't block startup on Target.getTargets — auto-attach delivers new
    // target events regardless, and existing targets get picked up when
    // their attach event fires.
    void this.probeExistingTargets(state);
  }

  private async probeExistingTargets(state: SessionState): Promise<void> {
    try {
      const list = await state.sendInternal<{ targetInfos: CdpTargetInfo[] }>("Target.getTargets");
      for (const ti of list.targetInfos ?? []) {
        if (ti.type === "page" || ti.type === "iframe") {
          state.sendInternalOneWay("Target.attachToTarget", { targetId: ti.targetId, flatten: true });
        }
      }
    } catch (err) {
      this.opts.logger?.("replay: Target.getTargets failed", {
        sessionId: this.opts.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  onEvent(msg: CdpMessage, state: SessionState): void | null {
    if (!this.started || this.capStopped) return;

    if (msg.method === "Target.attachedToTarget") {
      const params = msg.params as
        | { sessionId?: string; targetInfo?: CdpTargetInfo }
        | undefined;
      const ti = params?.targetInfo;
      const cdpSessionId = params?.sessionId;
      if (ti && cdpSessionId && (ti.type === "page" || ti.type === "iframe")) {
        this.armTarget(state, cdpSessionId, ti.targetId);
      }
      return;
    }

    if (msg.method === "Target.detachedFromTarget") {
      const params = msg.params as { sessionId?: string } | undefined;
      if (params?.sessionId) this.targets.delete(params.sessionId);
      return;
    }

    if (msg.method === "Page.frameNavigated" && msg.sessionId) {
      const params = msg.params as
        | { frame?: { url?: string; parentId?: string } }
        | undefined;
      if (params?.frame && !params.frame.parentId && params.frame.url) {
        const target = this.targets.get(msg.sessionId);
        if (target) target.lastUrl = params.frame.url;
      }
      return;
    }

    if (msg.method === "Page.screencastFrame" && msg.sessionId) {
      this.handleScreencastFrame(state, msg);
      return null;
    }
  }

  async onSessionEnd(state: SessionState, _reason: string): Promise<void> {
    if (!this.started) return;
    if (!this.capStopped) {
      for (const t of this.targets.values()) {
        state.sendInternalOneWay("Page.stopScreencast", {}, t.cdpSessionId);
      }
    }
    this.flushChunk();
    await Promise.allSettled(Array.from(this.pendingWrites));
    const manifest: ReplayManifest = {
      sessionId: this.opts.sessionId,
      format: this.opts.format,
      targets: Array.from(this.targets.values()).map((t) => t.targetId),
      frames: this.frames,
    };
    await this.opts.storage.finalize(this.opts.sessionId, manifest, {
      endedAt: Date.now(),
      frameCount: this.frames.length,
      sizeBytes: this.totalBytes,
      droppedFrames: this.droppedFrames,
      duplicatesSkipped: this.duplicatesSkipped,
    });
  }

  private armTarget(state: SessionState, cdpSessionId: string, targetId: string): void {
    if (this.targets.has(cdpSessionId)) return;
    this.targets.set(cdpSessionId, {
      targetId,
      cdpSessionId,
      frameCount: 0,
      sizeBytes: 0,
    });
    const w = this.opts.viewportWidth ?? 1280;
    const h = this.opts.viewportHeight ?? 720;
    state.sendInternalOneWay("Page.enable", {}, cdpSessionId);
    // must ack before Page.startScreencast — puppeteer/puppeteer#10527
    void state
      .sendInternal(
        "Page.setDeviceMetricsOverride",
        {
          width: w,
          height: h,
          deviceScaleFactor: this.opts.deviceScaleFactor ?? 1,
          mobile: false,
        },
        cdpSessionId,
      )
      .then(() =>
        state.sendInternal(
          "Page.startScreencast",
          {
            format: this.opts.format,
            quality: this.opts.quality,
            everyNthFrame: this.opts.everyNthFrame,
            maxWidth: w,
            maxHeight: h,
          },
          cdpSessionId,
        ),
      )
      .catch((err) => {
        this.opts.logger?.("screencast arm failed", {
          targetId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
  }

  private handleScreencastFrame(state: SessionState, msg: CdpMessage): void {
    const cdpSessionId = msg.sessionId!;
    const target = this.targets.get(cdpSessionId);
    if (!target) return;

    const params = msg.params as {
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

    state.sendInternalOneWay(
      "Page.screencastFrameAck",
      { sessionId: params.sessionId },
      cdpSessionId,
    );

    if (this.totalBytes >= this.opts.maxBytesPerSession) {
      if (!this.capStopped) {
        this.opts.logger?.("replay: per-session byte cap reached, stopping capture", {
          sessionId: this.opts.sessionId,
          totalBytes: this.totalBytes,
        });
        this.capStopped = true;
        for (const t of this.targets.values()) {
          state.sendInternalOneWay("Page.stopScreencast", {}, t.cdpSessionId);
        }
      }
      return;
    }

    if (this.opts.filterEmptyUrl && !target.lastUrl) {
      this.duplicatesSkipped++;
      return;
    }

    if (this.pendingWrites.size >= this.maxInFlight) {
      this.droppedFrames++;
      return;
    }

    const bytes = base64ToBytes(params.data);
    const hash = fnv1a32(bytes);
    if (target.lastFrameHash === hash) {
      this.duplicatesSkipped++;
      return;
    }
    target.lastFrameHash = hash;

    this.appendFrameToBuffer(target, bytes, params.metadata ?? {});
  }

  private appendFrameToBuffer(
    target: TargetState,
    bytes: Uint8Array,
    metadata: {
      timestamp?: number;
      deviceWidth?: number;
      deviceHeight?: number;
      scrollOffsetX?: number;
      scrollOffsetY?: number;
    },
  ): void {
    const now = Date.now();
    if (
      this.chunkBufferBytes > 0 &&
      (this.chunkBufferBytes + bytes.length + 4 > this.opts.chunkMaxBytes ||
        now - this.chunkOpenedAt > this.opts.chunkMaxElapsedMs)
    ) {
      this.flushChunk();
    }

    const byteOffset = this.chunkBufferBytes;
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, bytes.length, false);
    this.chunkBuffer.push(prefix, bytes);
    this.chunkBufferBytes += 4 + bytes.length;
    if (this.chunkBufferBytes === 4 + bytes.length) this.chunkOpenedAt = now;

    const record: ReplayFrameRecord = {
      frame: this.frames.length + 1,
      ts: metadata.timestamp ? Math.round(metadata.timestamp * 1000) : now,
      url: target.lastUrl ?? "",
      deviceWidth: metadata.deviceWidth ?? 0,
      deviceHeight: metadata.deviceHeight ?? 0,
      scrollX: metadata.scrollOffsetX ?? 0,
      scrollY: metadata.scrollOffsetY ?? 0,
      sizeBytes: bytes.length,
      targetId: target.targetId,
      chunkIndex: this.chunkIndex,
      byteOffset,
      length: bytes.length,
    };
    this.frames.push(record);

    target.frameCount++;
    target.sizeBytes += bytes.length;
    this.totalBytes += bytes.length;
  }

  private flushChunk(): void {
    if (this.chunkBufferBytes === 0) return;
    const data = concatBytes(this.chunkBuffer, this.chunkBufferBytes);
    const chunkIndex = this.chunkIndex;
    const write = this.opts.storage
      .writeChunk(this.opts.sessionId, chunkIndex, data)
      .catch((err) => {
        this.opts.logger?.("replay: writeChunk failed", {
          sessionId: this.opts.sessionId,
          chunkIndex,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    this.pendingWrites.add(write);
    write.finally(() => this.pendingWrites.delete(write));
    this.chunkIndex++;
    this.chunkBuffer = [];
    this.chunkBufferBytes = 0;
    this.chunkOpenedAt = 0;
  }
}

function fnv1a32(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
