/**
 * Regression test for the 0.3.3 fix: enabling profiles must survive a
 * subsequent writeConfig call.
 *
 * The bug was: `/v1/profiles/setup` appended a `profiles:` block to
 * gateway.yml but didn't update the in-memory `gateway.config.profiles`.
 * Adding a provider via `POST /v1/providers` triggered `writeConfig`, which
 * serialized the in-memory config (profiles.enabled still false) back to
 * disk and wiped the new block.
 *
 * Fix: `enableProfilesFlow` now also flips `config.profiles.enabled = true`,
 * and `writeConfig` includes the profiles block when serializing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayConfigSchema } from "../../src/core/types.js";
import { enableProfilesFlow } from "../../src/server/setup/profiles-setup.js";
import { writeConfig } from "../../src/server/config/writer.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bg-preserve-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("profiles block survives a writeConfig call", () => {
  it("enableProfilesFlow → writeConfig → profiles block still on disk", () => {
    const configPath = join(dir, "gateway.yml");
    writeFileSync(configPath, "version: 1\nproviders: {}\n");

    const config = GatewayConfigSchema.parse({
      providers: {},
    });

    expect(config.profiles.enabled).toBe(false);

    enableProfilesFlow({ configPath, config });

    expect(config.profiles.enabled).toBe(true);
    const after = readFileSync(configPath, "utf-8");
    expect(after).toMatch(/^profiles:/m);
    expect(after).toContain("enabled: true");

    config.providers["test-provider"] = {
      url: "wss://example.invalid/cdp",
      limits: { maxConcurrent: 2 },
      priority: 1,
      weight: 1,
    };
    writeConfig(config, configPath);

    const final = readFileSync(configPath, "utf-8");
    expect(final).toMatch(/^profiles:/m);
    expect(final).toContain("enabled: true");
    expect(final).toContain("test-provider");
  });

  it("writeConfig always serializes profiles + replay blocks so disable preserves user customizations", () => {
    const configPath = join(dir, "gateway.yml");
    const config = GatewayConfigSchema.parse({
      providers: {},
      profiles: { enabled: false, filesystem: { path: "./custom-profiles" } },
      replay: { enabled: false, retentionDays: 30 },
    });

    writeConfig(config, configPath);

    const yaml = readFileSync(configPath, "utf-8");
    expect(yaml).toMatch(/^profiles:/m);
    expect(yaml).toContain("./custom-profiles");
    expect(yaml).toMatch(/^replay:/m);
    expect(yaml).toContain("retentionDays: 30");
  });

  it("enableProfilesFlow without config arg still writes the file (legacy callers)", () => {
    const configPath = join(dir, "gateway.yml");
    writeFileSync(configPath, "version: 1\nproviders: {}\n");

    const result = enableProfilesFlow({ configPath });

    expect(result.configWritten).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toMatch(/^profiles:/m);
  });
});
