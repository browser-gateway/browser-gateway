import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { resolveEncryptionKey } from "../../../src/server/setup/encryption-key.js";

const KEY_FILE = ".encryption-key";

let dir: string;
let prevDataDir: string | undefined;
let prevKey: string | undefined;

beforeEach(() => {
  prevDataDir = process.env.BG_DATA_DIR;
  prevKey = process.env.BG_ENCRYPTION_KEY;
  dir = mkdtempSync(join(tmpdir(), "bg-key-"));
  process.env.BG_DATA_DIR = dir;
  delete process.env.BG_ENCRYPTION_KEY;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.BG_DATA_DIR;
  else process.env.BG_DATA_DIR = prevDataDir;
  if (prevKey === undefined) delete process.env.BG_ENCRYPTION_KEY;
  else process.env.BG_ENCRYPTION_KEY = prevKey;
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveEncryptionKey", () => {
  it("returns env value with source=env when BG_ENCRYPTION_KEY is set", () => {
    process.env.BG_ENCRYPTION_KEY = "from-env-AAAAAAAAAAAAAAAAAAAAAA";
    const result = resolveEncryptionKey();
    expect(result.source).toBe("env");
    expect(result.value).toBe("from-env-AAAAAAAAAAAAAAAAAAAAAA");
    expect(result.path).toBeNull();
  });

  it("reads from .encryption-key file when env is unset and file exists", () => {
    const existing = "from-file-BBBBBBBBBBBBBBBBBBBBBB";
    writeFileSync(join(dir, KEY_FILE), existing, { encoding: "utf-8", mode: 0o600 });
    const result = resolveEncryptionKey();
    expect(result.source).toBe("file");
    expect(result.value).toBe(existing);
    expect(result.path).toBe(join(dir, KEY_FILE));
  });

  it("generates a fresh 256-bit key when neither env nor file exists", () => {
    const result = resolveEncryptionKey();
    expect(result.source).toBe("generated");
    expect(result.value.length).toBeGreaterThanOrEqual(40); // 32 bytes base64
    expect(result.path).toBe(join(dir, KEY_FILE));
    expect(existsSync(join(dir, KEY_FILE))).toBe(true);
  });

  it("writes the generated key with mode 0600", () => {
    resolveEncryptionKey();
    const mode = statSync(join(dir, KEY_FILE)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("subsequent calls return the same generated key", () => {
    const first = resolveEncryptionKey();
    const second = resolveEncryptionKey();
    expect(second.source).toBe("file");
    expect(second.value).toBe(first.value);
  });

  it("env wins over file when both exist with different values, warns loudly", () => {
    writeFileSync(join(dir, KEY_FILE), "from-file-XXXXXXXXXXXXXXXXXXXXXX", { mode: 0o600 });
    process.env.BG_ENCRYPTION_KEY = "from-env-DIFFERENT-VALUE-XXXX";
    const logger = pino({ level: "warn" });
    const warn = vi.spyOn(logger, "warn");
    const result = resolveEncryptionKey(logger);
    expect(result.source).toBe("env");
    expect(result.value).toBe("from-env-DIFFERENT-VALUE-XXXX");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![1]).toMatch(/env var differs from existing key file/);
  });

  it("env equals file → no warning (matched config)", () => {
    const same = "matching-key-YYYYYYYYYYYYYYYYYYYY";
    writeFileSync(join(dir, KEY_FILE), same, { mode: 0o600 });
    process.env.BG_ENCRYPTION_KEY = same;
    const logger = pino({ level: "warn" });
    const warn = vi.spyOn(logger, "warn");
    resolveEncryptionKey(logger);
    expect(warn).not.toHaveBeenCalled();
  });

  it("repairs world-readable key file by chmod'ing it back to 0600", () => {
    writeFileSync(join(dir, KEY_FILE), "world-readable-key-ZZZZZZZZZZ", { mode: 0o600 });
    chmodSync(join(dir, KEY_FILE), 0o644);
    resolveEncryptionKey();
    const mode = statSync(join(dir, KEY_FILE)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
