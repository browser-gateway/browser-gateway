import { describe, expect, it } from "vitest";
import { isClientSessionKey } from "../../src/core/transport.js";

describe("isClientSessionKey", () => {
  it("accepts 8 to 64 letters, digits, underscores and dashes", () => {
    expect(isClientSessionKey("job-1234")).toBe(true);
    expect(isClientSessionKey("a".repeat(64))).toBe(true);
    expect(isClientSessionKey("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  it("refuses short, long and oddly spelled keys", () => {
    expect(isClientSessionKey("short")).toBe(false);
    expect(isClientSessionKey("a".repeat(65))).toBe(false);
    expect(isClientSessionKey("has space1")).toBe(false);
    expect(isClientSessionKey(null)).toBe(false);
  });
});
