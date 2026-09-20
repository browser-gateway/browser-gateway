import { describe, expect, it } from "vitest";
import { safeTokenCompare } from "../../src/server/util/token-compare.js";

describe("safeTokenCompare", () => {
  it("accepts an exact match", () => {
    expect(safeTokenCompare("s3cret-token", "s3cret-token")).toBe(true);
  });

  it("rejects a different token of the same length", () => {
    expect(safeTokenCompare("s3cret-token", "s3cret-tokeN")).toBe(false);
  });

  it("rejects a shorter token without throwing", () => {
    expect(() => safeTokenCompare("s3c", "s3cret-token")).not.toThrow();
    expect(safeTokenCompare("s3c", "s3cret-token")).toBe(false);
  });

  it("rejects a longer token without throwing", () => {
    expect(safeTokenCompare("s3cret-token-plus-more", "s3cret-token")).toBe(false);
  });

  it("rejects an empty candidate", () => {
    expect(safeTokenCompare("", "s3cret-token")).toBe(false);
  });

  it("rejects a candidate that is a prefix of the token", () => {
    expect(safeTokenCompare("s3cret", "s3cret-token")).toBe(false);
  });

  it("handles multi-byte characters without throwing on byte-length mismatch", () => {
    expect(() => safeTokenCompare("héllo", "hello")).not.toThrow();
    expect(safeTokenCompare("héllo", "hello")).toBe(false);
    expect(safeTokenCompare("héllo", "héllo")).toBe(true);
  });
});
