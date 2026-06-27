/**
 * Unit tests for the Enable-Profiles flow.
 *
 * As of v0.3.x the wizard only appends a `profiles:` block to gateway.yml.
 * The encryption key is auto-resolved at boot (env → data-dir file → generated)
 * by `setup/encryption-key.ts` — the wizard no longer touches `.env`.
 *
 * Invariants covered:
 *   1. Idempotent — running twice doesn't duplicate the block.
 *   2. Won't clobber an existing `profiles:` block in gateway.yml.
 *   3. Creates the file from scratch when missing (zero-config mode).
 *   4. Surfaces a clear error when the configPath isn't writable.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableProfilesFlow } from "../../../src/server/setup/profiles-setup.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bg-setup-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("enableProfilesFlow", () => {
  it("appends a profiles block to an existing gateway.yml", () => {
    const configPath = join(dir, "gateway.yml");
    writeFileSync(
      configPath,
      "version: 1\ngateway:\n  port: 9500\nproviders:\n  p1:\n    url: http://localhost:9222\n",
    );

    const result = enableProfilesFlow({ configPath });

    expect(result.configWritten).toBe(true);
    expect(result.configAlreadyHadBlock).toBe(false);
    expect(result.restartRequired).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toMatch(/^profiles:/m);
  });

  it("is idempotent — second call leaves the file untouched", () => {
    const configPath = join(dir, "gateway.yml");
    writeFileSync(configPath, "providers: {}\n");

    enableProfilesFlow({ configPath });
    const snap = readFileSync(configPath, "utf-8");

    const second = enableProfilesFlow({ configPath });

    expect(second.configWritten).toBe(false);
    expect(second.configAlreadyHadBlock).toBe(true);
    expect(second.restartRequired).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe(snap);
  });

  it("respects an existing profiles: block in gateway.yml", () => {
    const configPath = join(dir, "gateway.yml");
    writeFileSync(
      configPath,
      "providers: {}\nprofiles:\n  enabled: true\n  filesystem:\n    path: /var/lib/bg-profiles\n",
    );

    const result = enableProfilesFlow({ configPath });

    expect(result.configWritten).toBe(false);
    expect(result.configAlreadyHadBlock).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toContain("path: /var/lib/bg-profiles");
  });

  it("creates a minimal gateway.yml when the file is missing (zero-config mode)", () => {
    const configPath = join(dir, "new-config.yml");

    const result = enableProfilesFlow({ configPath });

    expect(result.configWritten).toBe(true);
    expect(result.configAlreadyHadBlock).toBe(false);
    expect(existsSync(configPath)).toBe(true);
    const yaml = readFileSync(configPath, "utf-8");
    expect(yaml).toMatch(/^profiles:/m);
    expect(yaml).toContain("enabled: true");
  });

  it("throws a clear error when the directory is read-only", () => {
    const readonlyDir = mkdtempSync(join(tmpdir(), "bg-setup-ro-"));
    try {
      chmodSync(readonlyDir, 0o500);
      expect(() => enableProfilesFlow({ configPath: join(readonlyDir, "gateway.yml") }))
        .toThrow(/Cannot write gateway\.yml/);
    } finally {
      chmodSync(readonlyDir, 0o700);
      rmSync(readonlyDir, { recursive: true, force: true });
    }
  });
});
