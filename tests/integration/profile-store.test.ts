import { mkdtemp, rm, symlink, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeBlob } from "../../src/core/profile/index.js";
import {
  FilesystemProfileStore,
  KeycheckMismatchError,
  initStore,
  openStore,
  readKeycheck,
  rewrapKeycheck,
} from "../../src/server/profile/index.js";

const STRONG_PWD = Buffer.alloc(32, "a").toString("base64");
const STRONG_PWD_2 = Buffer.alloc(32, "b").toString("base64");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bg-profile-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FilesystemProfileStore — round-trip", () => {
  it("stores and retrieves an encrypted blob", async () => {
    const opened = await initStore(dir, STRONG_PWD);
    const store = new FilesystemProfileStore({ storePath: dir });
    const plain = Buffer.from(JSON.stringify({ cookies: [{ k: "v" }] }));
    const dek = opened.dekByVersion.get(opened.currentDekVersion)!;
    const { bytes } = encodeBlob(dek, opened.currentDekVersion, plain, "acme-prod");
    await store.putRaw("acme-prod", bytes);
    const back = await store.getRaw("acme-prod");
    expect(back).not.toBeNull();
    expect(back!.equals(bytes)).toBe(true);
  });

  it("returns null for missing profile", async () => {
    await initStore(dir, STRONG_PWD);
    const store = new FilesystemProfileStore({ storePath: dir });
    expect(await store.getRaw("missing")).toBeNull();
  });

  it("lists profiles by id with metadata", async () => {
    const opened = await initStore(dir, STRONG_PWD);
    const store = new FilesystemProfileStore({ storePath: dir });
    const dek = opened.dekByVersion.get(opened.currentDekVersion)!;
    for (const id of ["a", "b", "c"]) {
      const { bytes } = encodeBlob(dek, opened.currentDekVersion, Buffer.from(id), id);
      await store.putRaw(id, bytes);
    }
    const meta = await store.list();
    expect(meta.map((m) => m.id).sort()).toEqual(["a", "b", "c"]);
    for (const m of meta) {
      expect(m.dekVersion).toBe(opened.currentDekVersion);
      expect(m.sizeBytes).toBeGreaterThan(0);
    }
  });

  it("deletes a profile", async () => {
    const opened = await initStore(dir, STRONG_PWD);
    const store = new FilesystemProfileStore({ storePath: dir });
    const dek = opened.dekByVersion.get(opened.currentDekVersion)!;
    const { bytes } = encodeBlob(dek, opened.currentDekVersion, Buffer.from("x"), "p");
    await store.putRaw("p", bytes);
    expect(await store.getRaw("p")).not.toBeNull();
    await store.delete("p");
    expect(await store.getRaw("p")).toBeNull();
  });
});

describe("FilesystemProfileStore — keycheck and rotation", () => {
  it("writes .keycheck on init", async () => {
    await initStore(dir, STRONG_PWD);
    const kc = await readKeycheck(dir);
    expect(kc).not.toBeNull();
    expect(kc!.wrappedDeks.length).toBe(1);
    expect(kc!.wrappedDeks[0]!.version).toBe(1);
  });

  it("openStore fails closed with the correct error on wrong password", async () => {
    await initStore(dir, STRONG_PWD);
    await expect(openStore(dir, STRONG_PWD_2)).rejects.toBeInstanceOf(KeycheckMismatchError);
  });

  it("error message points users at the rewrap command", async () => {
    await initStore(dir, STRONG_PWD);
    try {
      await openStore(dir, STRONG_PWD_2);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KeycheckMismatchError);
      expect((err as Error).message).toMatch(/profile key rewrap/);
      expect((err as Error).message).toMatch(/DESTROYS PROFILES/);
    }
  });

  it("opens cleanly with the right password", async () => {
    const initOpen = await initStore(dir, STRONG_PWD);
    const reopen = await openStore(dir, STRONG_PWD);
    expect(reopen.currentDekVersion).toBe(1);
    expect(reopen.dekByVersion.get(1)!.equals(initOpen.dekByVersion.get(1)!)).toBe(true);
  });

  it("rewraps keycheck so existing blobs still decrypt with new password", async () => {
    const opened = await initStore(dir, STRONG_PWD);
    const store = new FilesystemProfileStore({ storePath: dir });
    const dek = opened.dekByVersion.get(opened.currentDekVersion)!;
    const plain = Buffer.from(JSON.stringify({ session: "secret" }));
    const { bytes } = encodeBlob(dek, opened.currentDekVersion, plain, "acme");
    await store.putRaw("acme", bytes);

    await rewrapKeycheck(dir, STRONG_PWD, STRONG_PWD_2);

    await expect(openStore(dir, STRONG_PWD)).rejects.toBeInstanceOf(KeycheckMismatchError);
    const newOpen = await openStore(dir, STRONG_PWD_2);
    const dekAfter = newOpen.dekByVersion.get(opened.currentDekVersion)!;
    expect(dekAfter.equals(dek)).toBe(true);

    const stillRead = await store.getRaw("acme");
    expect(stillRead).not.toBeNull();
    expect(stillRead!.equals(bytes)).toBe(true);
  });
});

describe("FilesystemProfileStore — concurrency and locking", () => {
  it("rejects a second lock on the same profile while first is held", async () => {
    await initStore(dir, STRONG_PWD);
    const store = new FilesystemProfileStore({ storePath: dir, staleLockMs: 60_000 });
    const a = await store.lock("p1", 5_000);
    expect(a).not.toBeNull();
    const b = await store.lock("p1", 5_000);
    expect(b).toBeNull();
    await store.unlock("p1", a!);
    const c = await store.lock("p1", 5_000);
    expect(c).not.toBeNull();
    await store.unlock("p1", c!);
  });

  it("separate profile ids can be locked concurrently", async () => {
    await initStore(dir, STRONG_PWD);
    const store = new FilesystemProfileStore({ storePath: dir });
    const a = await store.lock("p1", 5_000);
    const b = await store.lock("p2", 5_000);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await store.unlock("p1", a!);
    await store.unlock("p2", b!);
  });

  it("concurrent writers — final file is one of the writes, never torn", async () => {
    const opened = await initStore(dir, STRONG_PWD);
    const store = new FilesystemProfileStore({ storePath: dir });
    const dek = opened.dekByVersion.get(opened.currentDekVersion)!;

    const blobs = Array.from({ length: 10 }, (_, i) =>
      encodeBlob(dek, opened.currentDekVersion, Buffer.from(`write-${i}`), "p").bytes,
    );

    await Promise.all(blobs.map((b) => store.putRaw("p", b)));

    const final = await store.getRaw("p");
    expect(final).not.toBeNull();
    const matchedSome = blobs.some((b) => b.equals(final!));
    expect(matchedSome).toBe(true);
  });
});

describe("FilesystemProfileStore — security defenses", () => {
  it("rejects invalid profile ids", async () => {
    await initStore(dir, STRONG_PWD);
    const store = new FilesystemProfileStore({ storePath: dir });
    const bad = ["", "../escape", "ab/c", "with space", ".hidden", "a".repeat(200)];
    for (const id of bad) {
      await expect(store.getRaw(id)).rejects.toThrow(/invalid|reserved|escape/i);
      await expect(store.putRaw(id, Buffer.alloc(50))).rejects.toThrow(/invalid|reserved|escape/i);
      await expect(store.lock(id, 1000)).rejects.toThrow(/invalid|reserved|escape/i);
    }
  });

  it("refuses to follow a symlink at the profile data path", async () => {
    await initStore(dir, STRONG_PWD);
    const store = new FilesystemProfileStore({ storePath: dir });
    const profileDir = join(dir, "target");
    const sensitiveFile = join(dir, "sensitive.txt");
    await writeFile(sensitiveFile, "highly sensitive", { mode: 0o600 });

    await (async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(profileDir, { recursive: true, mode: 0o700 });
    })();
    await symlink(sensitiveFile, join(profileDir, "data.enc"));

    await expect(store.getRaw("target")).rejects.toThrow(/symlink/);
    await expect(store.putRaw("target", Buffer.alloc(60))).rejects.toThrow(/symlink/);
    const sensitiveAfter = await stat(sensitiveFile);
    expect(sensitiveAfter.size).toBe(Buffer.from("highly sensitive").length);
  });

  it("putRaw rejects bytes that aren't a valid BGP1 blob", async () => {
    await initStore(dir, STRONG_PWD);
    const store = new FilesystemProfileStore({ storePath: dir });
    await expect(store.putRaw("p", randomBytes(64))).rejects.toThrow();
  });
});
