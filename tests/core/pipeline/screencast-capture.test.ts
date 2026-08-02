import { describe, it, expect } from "vitest";
import { Pipeline, type PipelineSocket } from "../../../src/pipeline/pipeline.js";
import type { CdpMessage } from "../../../src/pipeline/types.js";
import {
  ScreencastCapturePlugin,
  type ReplayStorage,
} from "../../../src/pipeline/plugins/screencast-capture.js";
import type { ReplayManifest, ReplayMeta } from "../../../src/server/replay/types.js";

class FakeSocket implements PipelineSocket {
  readonly sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  private listeners = new Map<string, Array<(ev: unknown) => void>>();
  bufferedAmount = 0;
  private closed = false;
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.closed) throw new Error("closed");
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.listeners.get("close") ?? []) l({});
  }
  addEventListener(type: string, listener: (ev: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  receive(data: string): void {
    for (const l of this.listeners.get("message") ?? []) l({ data });
  }
}

class FakeStorage implements ReplayStorage {
  meta: ReplayMeta | null = null;
  chunks: Array<{ chunkIndex: number; data: Uint8Array }> = [];
  finalManifest: ReplayManifest | null = null;
  finalSummary: {
    endedAt: number;
    frameCount: number;
    sizeBytes: number;
    droppedFrames: number;
    duplicatesSkipped: number;
  } | null = null;
  writeChunkDelayMs = 0;

  async init(_sessionId: string, meta: ReplayMeta): Promise<void> {
    this.meta = meta;
  }
  async writeChunk(_sessionId: string, chunkIndex: number, data: Uint8Array): Promise<void> {
    if (this.writeChunkDelayMs) await new Promise((r) => setTimeout(r, this.writeChunkDelayMs));
    this.chunks.push({ chunkIndex, data: new Uint8Array(data) });
  }
  async finalize(
    _sessionId: string,
    manifest: ReplayManifest,
    summary: {
      endedAt: number;
      frameCount: number;
      sizeBytes: number;
      droppedFrames: number;
      duplicatesSkipped: number;
    },
  ): Promise<void> {
    this.finalManifest = manifest;
    this.finalSummary = summary;
  }
}

const jsonMsg = (o: unknown): string => JSON.stringify(o);
const parseSent = (s: FakeSocket): CdpMessage[] =>
  s.sent
    .filter((x): x is string => typeof x === "string")
    .map((x) => { try { return JSON.parse(x) as CdpMessage; } catch { return null; } })
    .filter((x): x is CdpMessage => x !== null);

const FRAME_JPEG_1 = "AAECAwQFBgc="; // 8 bytes: 00 01 02 03 04 05 06 07
const FRAME_JPEG_2 = "CAkKCwwNDg8="; // 8 bytes: 08 09 0a 0b 0c 0d 0e 0f

async function driveScreencast(opts: {
  storage: FakeStorage;
  maxBytesPerSession?: number;
  chunkMaxBytes?: number;
  maxInFlightChunks?: number;
}) {
  const client = new FakeSocket();
  const upstream = new FakeSocket();
  const plugin = new ScreencastCapturePlugin({
    sessionId: "sess-1",
    providerId: "prov-1",
    storage: opts.storage,
    format: "jpeg",
    quality: 60,
    everyNthFrame: 1,
    maxBytesPerSession: opts.maxBytesPerSession ?? 1024 * 1024,
    chunkMaxBytes: opts.chunkMaxBytes ?? 25 * 1024 * 1024,
    chunkMaxElapsedMs: 60_000,
    maxInFlightChunks: opts.maxInFlightChunks,
  });
  const pipe = new Pipeline(client, upstream, "wss://test/", { plugins: [plugin], onSessionEndTimeoutMs: 500 });
  const done = pipe.run();
  await new Promise((r) => setTimeout(r, 5));
  return { client, upstream, plugin, done };
}

describe("ScreencastCapturePlugin", () => {
  it("initialises storage + sends Target.setAutoAttach + Target.getTargets on start", async () => {
    const storage = new FakeStorage();
    const { upstream, done, client } = await driveScreencast({ storage });

    // Answer Target.getTargets with an empty list so onSessionStart resolves.
    const sent = parseSent(upstream);
    const gt = sent.find((m) => m.method === "Target.getTargets");
    expect(sent.some((m) => m.method === "Target.setAutoAttach")).toBe(true);
    expect(gt).toBeDefined();
    upstream.receive(jsonMsg({ id: gt!.id, result: { targetInfos: [] } }));

    // Meta initialised.
    expect(storage.meta?.sessionId).toBe("sess-1");
    expect(storage.meta?.format).toBe("jpeg");
    expect(storage.meta?.providerId).toBe("prov-1");

    client.close();
    await done;
  });

  it("arms screencast on Target.attachedToTarget for a page target, captures frames, filters them from the client stream", async () => {
    const storage = new FakeStorage();
    const { upstream, client, done } = await driveScreencast({ storage });

    // Empty getTargets response first.
    const startSent = parseSent(upstream);
    const gt = startSent.find((m) => m.method === "Target.getTargets");
    upstream.receive(jsonMsg({ id: gt!.id, result: { targetInfos: [] } }));

    // Client's own attach fires the event.
    upstream.receive(jsonMsg({
      method: "Target.attachedToTarget",
      params: { sessionId: "S1", targetInfo: { targetId: "T1", type: "page" } },
    }));
    await new Promise((r) => setTimeout(r, 5));

    // Plugin should have sent Page.enable + Page.startScreencast on S1.
    const armed = parseSent(upstream).filter((m) => m.sessionId === "S1");
    expect(armed.some((m) => m.method === "Page.enable")).toBe(true);
    expect(armed.some((m) => m.method === "Page.startScreencast")).toBe(true);

    // Attach event was NOT filtered from client.
    const clientAttach = parseSent(client).find((m) => m.method === "Target.attachedToTarget");
    expect(clientAttach).toBeDefined();

    // Simulate frame arriving.
    upstream.receive(jsonMsg({
      sessionId: "S1",
      method: "Page.screencastFrame",
      params: {
        data: FRAME_JPEG_1,
        sessionId: 7,
        metadata: { timestamp: 1000, deviceWidth: 1280, deviceHeight: 720, scrollOffsetX: 0, scrollOffsetY: 0 },
      },
    }));
    await new Promise((r) => setTimeout(r, 5));

    // Frame filtered — client did NOT receive it.
    expect(parseSent(client).some((m) => m.method === "Page.screencastFrame")).toBe(false);

    // Plugin ACKed the frame back upstream on the same session.
    const acks = parseSent(upstream).filter((m) => m.method === "Page.screencastFrameAck" && m.sessionId === "S1");
    expect(acks.length).toBeGreaterThanOrEqual(1);

    client.close();
    await done;

    // Finalize summary matches.
    expect(storage.finalSummary?.frameCount).toBe(1);
    expect(storage.finalSummary?.sizeBytes).toBe(8);
    expect(storage.finalManifest?.frames[0].frame).toBe(1);
    expect(storage.finalManifest?.frames[0].length).toBe(8);
    expect(storage.finalManifest?.targets).toEqual(["T1"]);
  });

  it("dedupes identical consecutive frames + records the count", async () => {
    const storage = new FakeStorage();
    const { upstream, client, done } = await driveScreencast({ storage });

    const gt = parseSent(upstream).find((m) => m.method === "Target.getTargets");
    upstream.receive(jsonMsg({ id: gt!.id, result: { targetInfos: [] } }));
    upstream.receive(jsonMsg({
      method: "Target.attachedToTarget",
      params: { sessionId: "S1", targetInfo: { targetId: "T1", type: "page" } },
    }));
    await new Promise((r) => setTimeout(r, 5));

    const frame = (n: number, data: string) => ({
      sessionId: "S1",
      method: "Page.screencastFrame",
      params: { data, sessionId: n, metadata: {} },
    });
    upstream.receive(jsonMsg(frame(1, FRAME_JPEG_1)));
    upstream.receive(jsonMsg(frame(2, FRAME_JPEG_1))); // duplicate
    upstream.receive(jsonMsg(frame(3, FRAME_JPEG_2))); // new
    await new Promise((r) => setTimeout(r, 5));

    client.close();
    await done;

    expect(storage.finalSummary?.duplicatesSkipped).toBe(1);
    expect(storage.finalSummary?.frameCount).toBe(2);
    expect(storage.finalManifest?.frames.map((f) => f.length)).toEqual([8, 8]);
  });

  it("stops capture when the per-session byte cap is exceeded (fires Page.stopScreencast)", async () => {
    const storage = new FakeStorage();
    const { upstream, client, done } = await driveScreencast({
      storage,
      maxBytesPerSession: 4, // less than one frame — first frame passes the check (totalBytes=0), second frame trips it (totalBytes=8)
    });

    const gt = parseSent(upstream).find((m) => m.method === "Target.getTargets");
    upstream.receive(jsonMsg({ id: gt!.id, result: { targetInfos: [] } }));
    upstream.receive(jsonMsg({
      method: "Target.attachedToTarget",
      params: { sessionId: "S1", targetInfo: { targetId: "T1", type: "page" } },
    }));
    await new Promise((r) => setTimeout(r, 5));

    const frame = (n: number, data: string) => ({
      sessionId: "S1",
      method: "Page.screencastFrame",
      params: { data, sessionId: n, metadata: {} },
    });
    upstream.receive(jsonMsg(frame(1, FRAME_JPEG_1))); // 0 >= 4 false → captured, totalBytes=8
    upstream.receive(jsonMsg(frame(2, FRAME_JPEG_2))); // 8 >= 4 true → cap fires
    await new Promise((r) => setTimeout(r, 5));

    expect(
      parseSent(upstream).some((m) => m.method === "Page.stopScreencast" && m.sessionId === "S1"),
    ).toBe(true);

    client.close();
    await done;
    expect(storage.finalSummary?.frameCount).toBe(1);
  });

  it("frames span chunks: rollover when chunkMaxBytes is exceeded", async () => {
    const storage = new FakeStorage();
    // Chunk cap of 20 bytes; each frame writes 4-byte prefix + 8-byte data = 12 bytes.
    // Two frames = 24 > 20 → second frame triggers rollover.
    const { upstream, client, done } = await driveScreencast({
      storage,
      chunkMaxBytes: 20,
    });

    const gt = parseSent(upstream).find((m) => m.method === "Target.getTargets");
    upstream.receive(jsonMsg({ id: gt!.id, result: { targetInfos: [] } }));
    upstream.receive(jsonMsg({
      method: "Target.attachedToTarget",
      params: { sessionId: "S1", targetInfo: { targetId: "T1", type: "page" } },
    }));
    await new Promise((r) => setTimeout(r, 5));

    upstream.receive(jsonMsg({
      sessionId: "S1", method: "Page.screencastFrame",
      params: { data: FRAME_JPEG_1, sessionId: 1, metadata: {} },
    }));
    upstream.receive(jsonMsg({
      sessionId: "S1", method: "Page.screencastFrame",
      params: { data: FRAME_JPEG_2, sessionId: 2, metadata: {} },
    }));
    await new Promise((r) => setTimeout(r, 5));

    client.close();
    await done;

    // Two chunks written (000 and 001), each holds one frame.
    const chunkIndices = storage.chunks.map((c) => c.chunkIndex).sort();
    expect(chunkIndices).toEqual([0, 1]);
    expect(storage.finalManifest?.frames.map((f) => f.chunkIndex)).toEqual([0, 1]);
  });

  it("chunk on-disk format has 4-byte big-endian length prefix per frame", async () => {
    const storage = new FakeStorage();
    const { upstream, client, done } = await driveScreencast({ storage });

    const gt = parseSent(upstream).find((m) => m.method === "Target.getTargets");
    upstream.receive(jsonMsg({ id: gt!.id, result: { targetInfos: [] } }));
    upstream.receive(jsonMsg({
      method: "Target.attachedToTarget",
      params: { sessionId: "S1", targetInfo: { targetId: "T1", type: "page" } },
    }));
    await new Promise((r) => setTimeout(r, 5));
    upstream.receive(jsonMsg({
      sessionId: "S1", method: "Page.screencastFrame",
      params: { data: FRAME_JPEG_1, sessionId: 1, metadata: {} },
    }));
    await new Promise((r) => setTimeout(r, 5));

    client.close();
    await done;

    expect(storage.chunks.length).toBe(1);
    const chunk = storage.chunks[0].data;
    // First 4 bytes big-endian length = 8.
    const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    expect(dv.getUint32(0, false)).toBe(8);
    // Bytes 4..12 are frame contents.
    expect(Array.from(chunk.slice(4, 12))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Manifest byteOffset points at the prefix.
    expect(storage.finalManifest?.frames[0].byteOffset).toBe(0);
    expect(storage.finalManifest?.frames[0].length).toBe(8);
  });

  it("does NOT arm screencast on non-page targets (browser, worker)", async () => {
    const storage = new FakeStorage();
    const { upstream, client, done } = await driveScreencast({ storage });

    const gt = parseSent(upstream).find((m) => m.method === "Target.getTargets");
    upstream.receive(jsonMsg({ id: gt!.id, result: { targetInfos: [] } }));
    upstream.receive(jsonMsg({
      method: "Target.attachedToTarget",
      params: { sessionId: "S1", targetInfo: { targetId: "T1", type: "browser" } },
    }));
    upstream.receive(jsonMsg({
      method: "Target.attachedToTarget",
      params: { sessionId: "S2", targetInfo: { targetId: "T2", type: "service_worker" } },
    }));
    await new Promise((r) => setTimeout(r, 5));

    const armed = parseSent(upstream).filter(
      (m) => m.method === "Page.startScreencast",
    );
    expect(armed.length).toBe(0);

    client.close();
    await done;
    expect(storage.finalManifest?.targets ?? []).toEqual([]);
  });

  it("drops frames when writes stall past maxInFlightChunks (backpressure)", async () => {
    const storage = new FakeStorage();
    storage.writeChunkDelayMs = 200; // hold up write completion

    const { upstream, client, done } = await driveScreencast({
      storage,
      chunkMaxBytes: 20, // force rollover per frame
      maxInFlightChunks: 2,
    });

    const gt = parseSent(upstream).find((m) => m.method === "Target.getTargets");
    upstream.receive(jsonMsg({ id: gt!.id, result: { targetInfos: [] } }));
    upstream.receive(jsonMsg({
      method: "Target.attachedToTarget",
      params: { sessionId: "S1", targetInfo: { targetId: "T1", type: "page" } },
    }));
    await new Promise((r) => setTimeout(r, 5));

    // Fire 5 unique frames rapidly. First 2 fill the queue; rest get dropped.
    for (let i = 0; i < 5; i++) {
      const b64 = btoa(String.fromCharCode(0x10 + i, 0x20 + i, 0x30 + i, 0x40 + i, 0x50 + i, 0x60 + i, 0x70 + i, 0x00 + i));
      upstream.receive(jsonMsg({
        sessionId: "S1", method: "Page.screencastFrame",
        params: { data: b64, sessionId: i + 1, metadata: {} },
      }));
    }
    await new Promise((r) => setTimeout(r, 10));

    client.close();
    await done;

    // Some frames were captured before the queue filled; others dropped.
    expect((storage.finalSummary?.droppedFrames ?? 0)).toBeGreaterThan(0);
    expect((storage.finalSummary?.frameCount ?? 0)).toBeLessThan(5);
  });
});
