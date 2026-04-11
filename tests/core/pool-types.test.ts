import { describe, it, expect } from "vitest";
import { PoolConfigSchema } from "../../src/core/pool/types.js";

describe("PoolConfigSchema", () => {
  it("should apply all defaults", () => {
    const config = PoolConfigSchema.parse({});
    expect(config.minSessions).toBe(0);
    expect(config.maxSessions).toBe(5);
    expect(config.maxPagesPerSession).toBe(10);
    expect(config.retireAfterPages).toBe(100);
    expect(config.retireAfterMs).toBe(3600000);
    expect(config.idleTimeoutMs).toBe(300000);
    expect(config.pageTimeoutMs).toBe(30000);
  });

  it("should accept custom values", () => {
    const config = PoolConfigSchema.parse({
      minSessions: 2,
      maxSessions: 10,
      maxPagesPerSession: 20,
      retireAfterPages: 200,
      retireAfterMs: 7200000,
      idleTimeoutMs: 600000,
      pageTimeoutMs: 60000,
    });
    expect(config.minSessions).toBe(2);
    expect(config.maxSessions).toBe(10);
    expect(config.maxPagesPerSession).toBe(20);
  });

  it("should reject minSessions below 0", () => {
    expect(() => PoolConfigSchema.parse({ minSessions: -1 })).toThrow();
  });

  it("should reject maxSessions below 1", () => {
    expect(() => PoolConfigSchema.parse({ maxSessions: 0 })).toThrow();
  });

  it("should reject maxPagesPerSession below 1", () => {
    expect(() => PoolConfigSchema.parse({ maxPagesPerSession: 0 })).toThrow();
  });

  it("should reject retireAfterMs below 10000", () => {
    expect(() => PoolConfigSchema.parse({ retireAfterMs: 5000 })).toThrow();
  });

  it("should reject idleTimeoutMs below 5000", () => {
    expect(() => PoolConfigSchema.parse({ idleTimeoutMs: 1000 })).toThrow();
  });

  it("should reject pageTimeoutMs below 1000", () => {
    expect(() => PoolConfigSchema.parse({ pageTimeoutMs: 500 })).toThrow();
  });

  it("should allow minSessions of 0 (scale-to-zero)", () => {
    const config = PoolConfigSchema.parse({ minSessions: 0 });
    expect(config.minSessions).toBe(0);
  });
});
