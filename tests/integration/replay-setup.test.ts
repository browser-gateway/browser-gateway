import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayConfigSchema } from "../../src/core/types.js";
import { disableReplayFlow, enableReplayFlow } from "../../src/server/setup/replay-setup.js";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bg-replay-setup-"));
  configPath = join(dir, "gateway.yml");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("enableReplayFlow", () => {
  it("flips replay.enabled false → true, writes config, signals restart", () => {
    const config = GatewayConfigSchema.parse({ providers: {} });
    expect(config.replay.enabled).toBe(false);

    const r = enableReplayFlow({ configPath, config });

    expect(r.configWritten).toBe(true);
    expect(r.alreadyInDesiredState).toBe(false);
    expect(r.restartRequired).toBe(true);
    expect(config.replay.enabled).toBe(true);

    const yaml = readFileSync(configPath, "utf-8");
    expect(yaml).toMatch(/^replay:/m);
    expect(yaml).toContain("enabled: true");
  });

  it("no-op when already enabled", () => {
    const config = GatewayConfigSchema.parse({ providers: {}, replay: { enabled: true } });
    const r = enableReplayFlow({ configPath, config });
    expect(r.configWritten).toBe(false);
    expect(r.alreadyInDesiredState).toBe(true);
    expect(r.restartRequired).toBe(false);
  });
});

describe("disableReplayFlow", () => {
  it("flips replay.enabled true → false, writes config preserving customizations", () => {
    const config = GatewayConfigSchema.parse({
      providers: {},
      replay: { enabled: true, retentionDays: 30, maxBytesPerSession: 100 * 1024 * 1024 },
    });

    const r = disableReplayFlow({ configPath, config });

    expect(r.configWritten).toBe(true);
    expect(r.restartRequired).toBe(true);
    expect(config.replay.enabled).toBe(false);

    const yaml = readFileSync(configPath, "utf-8");
    expect(yaml).toMatch(/^replay:/m);
    expect(yaml).toContain("enabled: false");
    expect(yaml).toContain("retentionDays: 30");
  });

  it("no-op when already disabled", () => {
    const config = GatewayConfigSchema.parse({ providers: {} });
    const r = disableReplayFlow({ configPath, config });
    expect(r.configWritten).toBe(false);
    expect(r.alreadyInDesiredState).toBe(true);
    expect(r.restartRequired).toBe(false);
  });
});
