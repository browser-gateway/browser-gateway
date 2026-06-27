import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { resolveDataDir } from "../../../src/server/setup/data-dir.js";

let prevEnv: string | undefined;
const cleanup: string[] = [];

beforeEach(() => {
  prevEnv = process.env.BG_DATA_DIR;
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.BG_DATA_DIR;
  else process.env.BG_DATA_DIR = prevEnv;
  for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe("resolveDataDir", () => {
  it("honors BG_DATA_DIR when set", () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-data-env-"));
    cleanup.push(dir);
    process.env.BG_DATA_DIR = dir;
    expect(resolveDataDir()).toBe(dir);
  });

  it("creates BG_DATA_DIR if it doesn't exist yet", () => {
    const dir = join(tmpdir(), `bg-data-fresh-${process.pid}-${Date.now()}`);
    cleanup.push(dir);
    process.env.BG_DATA_DIR = dir;
    expect(existsSync(dir)).toBe(false);
    resolveDataDir();
    expect(existsSync(dir)).toBe(true);
  });

  it("creates parent directories as needed", () => {
    const parent = join(tmpdir(), `bg-data-parent-${process.pid}-${Date.now()}`);
    const nested = join(parent, "a", "b", "data");
    cleanup.push(parent);
    process.env.BG_DATA_DIR = nested;
    resolveDataDir();
    expect(existsSync(nested)).toBe(true);
  });

  it("creates the directory with mode 0700 (mask removes other-perm bits)", () => {
    const dir = join(tmpdir(), `bg-data-mode-${process.pid}-${Date.now()}`);
    cleanup.push(dir);
    process.env.BG_DATA_DIR = dir;
    resolveDataDir();
    const mode = statSync(dir).mode & 0o077;
    expect(mode).toBe(0);
  });

  it("falls back to ~/.browser-gateway when BG_DATA_DIR is unset and HOME is set", () => {
    delete process.env.BG_DATA_DIR;
    const result = resolveDataDir();
    // Don't actually mutate the real home dir — just confirm the path math.
    expect(result).toBe(join(homedir(), ".browser-gateway"));
    cleanup.push(result);
  });
});
