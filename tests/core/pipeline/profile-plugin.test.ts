import { describe, it, expect } from "vitest";
import { Pipeline, type PipelineSocket } from "../../../src/pipeline/pipeline.js";
import { ProfilePlugin, ProfilePluginError } from "../../../src/pipeline/plugins/profile.js";
import type {
  LoadedProfile,
  LockToken,
  ProfileStorage,
} from "../../../src/pipeline/plugins/profile-storage.js";
import type { CapturedProfile } from "../../../src/core/profile/types.js";

class FakeSocket implements PipelineSocket {
  readonly sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  private listeners = new Map<string, Array<(ev: unknown) => void>>();
  bufferedAmount = 0;
  closed = false;

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.closed) return;
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }
  addEventListener(type: string, listener: (ev: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  receive(data: string | ArrayBuffer | ArrayBufferView): void {
    this.emit("message", { data });
  }
  /** Auto-respond to any injected command with a canned result. */
  autoReplyResults: Record<string, unknown> = {};
  private emit(type: string, ev: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
    if (type === "message") {
      const data = (ev as { data?: unknown })?.data;
      if (typeof data === "string" && data.startsWith("{")) {
        try {
          const msg = JSON.parse(data) as { id?: number; method?: string };
          if (typeof msg.id === "number" && msg.method) {
            queueMicrotask(() => {
              const result = this.autoReplyResults[msg.method!] ?? {};
              this.emit("message", {
                data: JSON.stringify({ id: msg.id, result }),
              });
            });
          }
        } catch { /* ignore */ }
      }
    }
  }
}

class FakeStorage implements ProfileStorage {
  loadResult: LoadedProfile | null = null;
  loadThrows: Error | null = null;
  acquireLockResult: LockToken | null = "tok-1";
  saved: Array<{ profileId: string; profile: CapturedProfile }> = [];
  released: string[] = [];

  async load(_id: string): Promise<LoadedProfile | null> {
    if (this.loadThrows) throw this.loadThrows;
    return this.loadResult;
  }
  async save(profileId: string, profile: CapturedProfile): Promise<void> {
    this.saved.push({ profileId, profile });
  }
  async acquireLock(_id: string, _ttl: number): Promise<LockToken | null> {
    return this.acquireLockResult;
  }
  async releaseLock(id: string): Promise<void> {
    this.released.push(id);
  }
}

const validId = "profile-abc-123";

describe("ProfilePlugin — constructor + eligibility", () => {
  it("rejects an invalid profile id at construction", () => {
    const storage = new FakeStorage();
    expect(() => new ProfilePlugin({ profileId: "bad id!", storage })).toThrowError(
      ProfilePluginError,
    );
  });
});

describe("ProfilePlugin — start()", () => {
  it("start() fails with LOCK_HELD when acquireLock returns null", async () => {
    const upstream = new FakeSocket();
    const storage = new FakeStorage();
    storage.acquireLockResult = null;

    const plugin = new ProfilePlugin({ profileId: validId, storage });
    const p = new Pipeline(upstream, "wss://test/", {
      plugins: [plugin],
      onSessionEndTimeoutMs: 100,
    });
    const s = await p.start();
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.plugin).toBe("profile");
    expect(storage.released).toEqual([]);
    expect(upstream.closed).toBe(true);
  });

  it("start() fails on decrypt error and releases the lock", async () => {
    const upstream = new FakeSocket();
    const storage = new FakeStorage();
    storage.loadThrows = new Error("failed to decrypt profile: HMAC mismatch");

    const plugin = new ProfilePlugin({ profileId: validId, storage });
    const p = new Pipeline(upstream, "wss://test/", {
      plugins: [plugin],
      onSessionEndTimeoutMs: 100,
    });
    const s = await p.start();
    expect(s.ok).toBe(false);
    expect(storage.released).toEqual([validId]);
  });

  it("start() fails on unknown DEK version", async () => {
    const upstream = new FakeSocket();
    const storage = new FakeStorage();
    storage.loadThrows = new Error("profile blob references DEK version 9 not in key ring");

    const plugin = new ProfilePlugin({ profileId: validId, storage });
    const p = new Pipeline(upstream, "wss://test/", {
      plugins: [plugin],
      onSessionEndTimeoutMs: 100,
    });
    const s = await p.start();
    expect(s.ok).toBe(false);
    expect(storage.released).toEqual([validId]);
  });
});

// Full inject/capture round-trip is covered by tier-2 integration tests using
// real Chrome via chrome-launcher (see tests/integration/profile-*.test.ts).
// Unit tests here focus on constructor + storage/lock/error paths that are
// hard to exercise from integration.
