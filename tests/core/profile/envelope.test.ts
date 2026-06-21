import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newDek, unwrapDek, wrapDek } from "../../../src/core/profile/envelope.js";

const KEK = () => randomBytes(32);

describe("envelope (DEK wrap/unwrap)", () => {
  it("round-trips a DEK with the same KEK", () => {
    const kek = KEK();
    const dek = newDek();
    const wrapped = wrapDek(kek, dek, 1);
    const back = unwrapDek(kek, wrapped);
    expect(back.equals(dek)).toBe(true);
  });

  it("preserves the version field", () => {
    const wrapped = wrapDek(KEK(), newDek(), 7);
    expect(wrapped.version).toBe(7);
  });

  it("fails to unwrap with the wrong KEK", () => {
    const dek = newDek();
    const wrapped = wrapDek(KEK(), dek, 1);
    expect(() => unwrapDek(KEK(), wrapped)).toThrow();
  });

  it("fails to unwrap if wrapped ciphertext is tampered", () => {
    const kek = KEK();
    const wrapped = wrapDek(kek, newDek(), 1);
    const broken = { ...wrapped, wrappedB64: Buffer.from(wrapped.wrappedB64, "base64").fill(0, 0, 1).toString("base64") };
    expect(() => unwrapDek(kek, broken)).toThrow();
  });

  it("newDek returns 32 fresh bytes", () => {
    expect(newDek().length).toBe(32);
    expect(newDek().equals(newDek())).toBe(false);
  });
});
