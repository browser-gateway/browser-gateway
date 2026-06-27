import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { resolveStorePath } from "../../../src/server/profile/bootstrap.js";

describe("resolveStorePath", () => {
  const originalEnv = process.env.BG_DATA_DIR;
  const cleanup: string[] = [];

  beforeEach(() => {
    delete process.env.BG_DATA_DIR;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.BG_DATA_DIR;
    else process.env.BG_DATA_DIR = originalEnv;
    for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true });
  });

  it("returns absolute config paths verbatim", () => {
    expect(resolveStorePath("/var/lib/bg/profiles")).toBe("/var/lib/bg/profiles");
  });

  it("ignores BG_DATA_DIR for absolute paths (operator override wins)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bg-store-"));
    cleanup.push(dataDir);
    process.env.BG_DATA_DIR = dataDir;
    expect(resolveStorePath("/srv/profiles")).toBe("/srv/profiles");
  });

  it("joins relative paths under BG_DATA_DIR when set", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bg-store-"));
    cleanup.push(dataDir);
    process.env.BG_DATA_DIR = dataDir;
    expect(resolveStorePath("./profiles")).toBe(`${dataDir}/profiles`);
    expect(resolveStorePath("profiles")).toBe(`${dataDir}/profiles`);
  });

  it("falls back to ~/.browser-gateway for relative paths when BG_DATA_DIR is unset", () => {
    const expected = join(homedir(), ".browser-gateway", "profiles");
    cleanup.push(join(homedir(), ".browser-gateway"));
    expect(resolveStorePath("./profiles")).toBe(expected);
  });

  it("handles nested relative paths", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bg-store-"));
    cleanup.push(dataDir);
    process.env.BG_DATA_DIR = dataDir;
    expect(resolveStorePath("./profiles/v2")).toBe(`${dataDir}/profiles/v2`);
  });
});
