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
