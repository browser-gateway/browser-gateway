/**
 * Unit tests for the Enable-Profiles flow — the one-click backend that writes
 * BG_ENCRYPTION_KEY to .env and appends `profiles:` to gateway.yml.
 *
 * Critical invariants:
 *   1. Idempotent — running twice doesn't duplicate the block / key.
 *   2. Won't clobber an existing user-set BG_ENCRYPTION_KEY (we respect their
 *      vault/.env value if it's already there).
 *   3. Won't clobber an existing `profiles:` block in gateway.yml (could have
 *      custom paths/keyEnv we shouldn't overwrite).
 *   4. Validates the key shape — rejects empty / short / non-base64 input.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableProfilesFlow } from "../../../src/server/setup/profiles-setup.js";

let dir: string;
const VALID_KEY = "zSO+Nca/IIt38+UdC7SXFF44XHCHq2vDFDviiNOwcdk=";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bg-setup-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("enableProfilesFlow", () => {
  it("creates .env when missing and appends profiles block to gateway.yml", () => {
    const envPath = join(dir, ".env");
    const configPath = join(dir, "gateway.yml");
    writeFileSync(
      configPath,
      "version: 1\ngateway:\n  port: 9500\nproviders:\n  p1:\n    url: http://localhost:9222\n",
    );

    const result = enableProfilesFlow({ encryptionKey: VALID_KEY, configPath, envPath });

    expect(result.envWritten).toBe(true);
    expect(result.envAlreadyHadKey).toBe(false);
    expect(result.configWritten).toBe(true);
    expect(result.configAlreadyHadBlock).toBe(false);
    expect(result.restartRequired).toBe(true);

    expect(readFileSync(envPath, "utf-8")).toMatch(/^BG_ENCRYPTION_KEY="zSO\+/m);
    expect(readFileSync(configPath, "utf-8")).toMatch(/^profiles:/m);
  });

  it("is idempotent — second call writes nothing", () => {
    const envPath = join(dir, ".env");
    const configPath = join(dir, "gateway.yml");
    writeFileSync(configPath, "providers: {}\n");

    enableProfilesFlow({ encryptionKey: VALID_KEY, configPath, envPath });
    const envSnap = readFileSync(envPath, "utf-8");
    const yamlSnap = readFileSync(configPath, "utf-8");

    const result2 = enableProfilesFlow({ encryptionKey: VALID_KEY, configPath, envPath });

    expect(result2.envWritten).toBe(false);
    expect(result2.envAlreadyHadKey).toBe(true);
    expect(result2.configWritten).toBe(false);
    expect(result2.configAlreadyHadBlock).toBe(true);
    expect(result2.restartRequired).toBe(false);

    expect(readFileSync(envPath, "utf-8")).toBe(envSnap);
    expect(readFileSync(configPath, "utf-8")).toBe(yamlSnap);
  });

  it("respects an existing BG_ENCRYPTION_KEY in .env (user manages it elsewhere)", () => {
    const envPath = join(dir, ".env");
    const configPath = join(dir, "gateway.yml");
    writeFileSync(envPath, 'BG_ENCRYPTION_KEY="from-1password"\nOTHER=foo\n');
    writeFileSync(configPath, "providers: {}\n");

    const result = enableProfilesFlow({ encryptionKey: VALID_KEY, configPath, envPath });

    expect(result.envWritten).toBe(false);
    expect(result.envAlreadyHadKey).toBe(true);
    expect(readFileSync(envPath, "utf-8")).toContain('BG_ENCRYPTION_KEY="from-1password"');
    expect(readFileSync(envPath, "utf-8")).not.toContain(VALID_KEY);
  });

  it("respects an existing profiles: block in gateway.yml", () => {
    const envPath = join(dir, ".env");
    const configPath = join(dir, "gateway.yml");
    writeFileSync(
      configPath,
      "providers: {}\nprofiles:\n  enabled: true\n  filesystem:\n    path: /var/lib/bg-profiles\n",
    );

    const result = enableProfilesFlow({ encryptionKey: VALID_KEY, configPath, envPath });

    expect(result.configWritten).toBe(false);
    expect(result.configAlreadyHadBlock).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toContain("path: /var/lib/bg-profiles");
  });

  it("creates a minimal gateway.yml when the file is missing (zero-config mode)", () => {
    const envPath = join(dir, ".env");
    const configPath = join(dir, "new-config.yml"); // intentionally missing

    const result = enableProfilesFlow({ encryptionKey: VALID_KEY, configPath, envPath });

    expect(result.envWritten).toBe(true);
    expect(result.configWritten).toBe(true);
    expect(result.configAlreadyHadBlock).toBe(false);
    expect(existsSync(configPath)).toBe(true);
    const yaml = readFileSync(configPath, "utf-8");
    expect(yaml).toMatch(/^profiles:/m);
    expect(yaml).toContain("enabled: true");
  });

  it("rejects short, empty, or non-base64 keys", () => {
    const envPath = join(dir, ".env");
    const configPath = join(dir, "gateway.yml");
    writeFileSync(configPath, "providers: {}\n");

    expect(() => enableProfilesFlow({ encryptionKey: "", configPath, envPath })).toThrow();
    expect(() => enableProfilesFlow({ encryptionKey: "short", configPath, envPath })).toThrow();
    expect(() => enableProfilesFlow({ encryptionKey: "not!base64!chars", configPath, envPath })).toThrow();
  });

  it("normalises terminal newlines — no double-blanks if file lacks trailing \\n", () => {
    const envPath = join(dir, ".env");
    const configPath = join(dir, "gateway.yml");
    writeFileSync(envPath, "OTHER=x"); // intentionally no trailing newline
    writeFileSync(configPath, "providers: {}"); // intentionally no trailing newline

    enableProfilesFlow({ encryptionKey: VALID_KEY, configPath, envPath });

    expect(readFileSync(envPath, "utf-8")).not.toContain("\n\n\n");
    expect(readFileSync(configPath, "utf-8")).not.toContain("\n\n\n");
  });
});
