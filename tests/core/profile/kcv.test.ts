import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeKcv } from "../../../src/core/profile/kcv.js";

describe("kcv", () => {
  it("returns 3 bytes", () => {
    const k = randomBytes(32);
    expect(computeKcv(k).length).toBe(3);
  });

  it("is deterministic for same key", () => {
    const k = randomBytes(32);
    expect(computeKcv(k).equals(computeKcv(k))).toBe(true);
  });

  it("differs across keys", () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(computeKcv(a).equals(computeKcv(b))).toBe(false);
  });

  it("rejects keys of wrong size", () => {
    expect(() => computeKcv(randomBytes(16))).toThrow(/32 bytes/);
    expect(() => computeKcv(randomBytes(64))).toThrow(/32 bytes/);
  });
});
