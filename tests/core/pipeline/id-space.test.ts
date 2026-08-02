import { describe, it, expect } from "vitest";
import { InternalIdSpace } from "../../../src/pipeline/id-space.js";

describe("InternalIdSpace", () => {
  it("allocates IDs starting at 2^30", () => {
    const s = new InternalIdSpace();
    const first = s.allocate().id;
    const second = s.allocate().id;
    expect(first).toBe(1 << 30);
    expect(second).toBe((1 << 30) + 1);
  });

  it("owns() true for allocated, false for unknown", () => {
    const s = new InternalIdSpace();
    const { id } = s.allocate();
    expect(s.owns(id)).toBe(true);
    expect(s.owns(id + 1000)).toBe(false);
    expect(s.owns(1)).toBe(false);
  });

  it("settle() resolves the pending promise with result", async () => {
    const s = new InternalIdSpace();
    const { id, promise } = s.allocate();
    const settled = s.settle(id, { result: { foo: "bar" } });
    expect(settled).toBe(true);
    await expect(promise).resolves.toEqual({ foo: "bar" });
    expect(s.owns(id)).toBe(false);
  });

  it("settle() rejects when response carries an error", async () => {
    const s = new InternalIdSpace();
    const { id, promise } = s.allocate();
    s.settle(id, { error: { code: -32000, message: "oops" } });
    await expect(promise).rejects.toThrow(/-32000.*oops/);
  });

  it("settle() returns false when id is unknown", () => {
    const s = new InternalIdSpace();
    expect(s.settle(999, { result: {} })).toBe(false);
  });

  it("rejectAll() rejects every outstanding promise and clears state", async () => {
    const s = new InternalIdSpace();
    const a = s.allocate();
    const b = s.allocate();
    s.rejectAll("test");
    await expect(a.promise).rejects.toThrow(/test/);
    await expect(b.promise).rejects.toThrow(/test/);
    expect(s.pendingCount).toBe(0);
  });
});
