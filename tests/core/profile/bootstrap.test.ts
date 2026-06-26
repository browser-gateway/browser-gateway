import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { resolveStorePath } from "../../../src/server/profile/bootstrap.js";

describe("resolveStorePath", () => {
  const originalEnv = process.env.BG_DATA_DIR;

  beforeEach(() => {
    delete process.env.BG_DATA_DIR;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.BG_DATA_DIR;
    else process.env.BG_DATA_DIR = originalEnv;
  });

  it("returns absolute config paths verbatim", () => {
    expect(resolveStorePath("/var/lib/bg/profiles")).toBe("/var/lib/bg/profiles");
  });

  it("ignores BG_DATA_DIR for absolute paths (operator override wins)", () => {
    process.env.BG_DATA_DIR = "/data";
    expect(resolveStorePath("/srv/profiles")).toBe("/srv/profiles");
  });

  it("joins relative paths under BG_DATA_DIR when set", () => {
    process.env.BG_DATA_DIR = "/data";
    expect(resolveStorePath("./profiles")).toBe("/data/profiles");
    expect(resolveStorePath("profiles")).toBe("/data/profiles");
  });

  it("falls back to CWD for relative paths when BG_DATA_DIR is unset", () => {
    expect(resolveStorePath("./profiles")).toBe(resolve("./profiles"));
  });

  it("handles nested relative paths", () => {
    process.env.BG_DATA_DIR = "/data";
    expect(resolveStorePath("./profiles/v2")).toBe("/data/profiles/v2");
  });
});
