import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { GatewayConfigSchema } from "../../src/core/types.js";
import { writeConfig } from "../../src/server/config/writer.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bg-writer-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function roundTrip(providers: Record<string, unknown>) {
  const configPath = join(dir, "gateway.yml");
  writeConfig(GatewayConfigSchema.parse({ providers }), configPath);
  return GatewayConfigSchema.parse(parse(readFileSync(configPath, "utf-8")));
}

describe("writeConfig provider fields", () => {
  it("keeps auth headers on a provider across a save", () => {
    const reread = roundTrip({
      cloud: { url: "wss://example.invalid/cdp", headers: { Authorization: "Bearer abc" } },
    });
    expect(reread.providers["cloud"]?.headers).toEqual({ Authorization: "Bearer abc" });
  });

  it("writes no headers key for a provider without headers", () => {
    const configPath = join(dir, "gateway.yml");
    writeConfig(
      GatewayConfigSchema.parse({ providers: { plain: { url: "wss://example.invalid/cdp", headers: {} } } }),
      configPath,
    );
    expect(readFileSync(configPath, "utf-8")).not.toContain("headers");
  });
});

describe("writeConfig session defaults", () => {
  it("writes nothing for session defaults while every default is off", () => {
    const configPath = join(dir, "gateway.yml");
    writeConfig(GatewayConfigSchema.parse({ providers: {} }), configPath);
    expect(readFileSync(configPath, "utf-8")).not.toContain("sessionDefaults");
  });

  it("keeps session defaults across a save once one is set", () => {
    const configPath = join(dir, "gateway.yml");
    writeConfig(GatewayConfigSchema.parse({ providers: {}, sessionDefaults: { record: true, proxy: "home" } }), configPath);
    const reread = GatewayConfigSchema.parse(parse(readFileSync(configPath, "utf-8")));
    expect(reread.sessionDefaults).toEqual({ record: true, profile: null, saveProfile: false, proxy: "home" });
  });
});

describe("writeConfig gateway settings", () => {
  it("keeps the queue and drain settings across a save", () => {
    const configPath = join(dir, "gateway.yml");
    writeConfig(GatewayConfigSchema.parse({ providers: {}, gateway: { queue: { maxSize: 7, timeoutMs: 1234 }, shutdownDrainMs: 4321 } }), configPath);
    const reread = GatewayConfigSchema.parse(parse(readFileSync(configPath, "utf-8")));
    expect(reread.gateway.queue).toEqual({ maxSize: 7, timeoutMs: 1234 });
    expect(reread.gateway.shutdownDrainMs).toBe(4321);
  });
});

describe("writeConfig pool and rest settings", () => {
  it("keeps changed pool and rest settings across a save", () => {
    const configPath = join(dir, "gateway.yml");
    writeConfig(GatewayConfigSchema.parse({
      providers: {},
      pool: { maxSessions: 2 },
      rest: { allowedPrivateHosts: ["intranet.local"] },
    }), configPath);
    const reread = GatewayConfigSchema.parse(parse(readFileSync(configPath, "utf-8")));
    expect(reread.pool.maxSessions).toBe(2);
    expect(reread.rest.allowedPrivateHosts).toEqual(["intranet.local"]);
  });

  it("writes nothing for them while they are at their defaults", () => {
    const configPath = join(dir, "gateway.yml");
    writeConfig(GatewayConfigSchema.parse({ providers: {} }), configPath);
    const text = readFileSync(configPath, "utf-8");
    expect(text).not.toMatch(/^pool:|^rest:/m);
  });
});
