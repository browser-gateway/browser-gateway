import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { aeadDecrypt } from "../../../src/core/profile/encryption.js";
import { newDek, unwrapDek, wrapDek } from "../../../src/core/profile/envelope.js";

const KEK = () => randomBytes(32);

// Hardcoded AAD constant from envelope.ts — duplicated here so a test fails
// loudly if someone changes the constant in src/ without thinking through the
// crypto-binding implications. Catches the Stryker mutation that replaces the
// AAD string literal with empty.
const EXPECTED_DEK_WRAP_AAD = "browser-gateway:dek-wrap:v1";

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

  // ─── Mutation-coverage tests ───

  // Wraps the actual AAD constant value into the test. wrapDek uses a specific
  // AAD string ("browser-gateway:dek-wrap:v1"); if a mutation changes it to ""
  // or anything else, this independent decrypt-with-known-AAD will mismatch.
  it("wrapped DEK can be unwrapped by aeadDecrypt with the documented AAD", () => {
    const kek = KEK();
    const dek = newDek();
    const wrapped = wrapDek(kek, dek, 1);

    // Manually decrypt using the EXPECTED AAD constant. If src/envelope.ts ever
    // ships a different AAD (typo, mutation, deliberate change), this fails.
    const iv = Buffer.from(wrapped.ivB64, "base64");
    const ciphertext = Buffer.from(wrapped.wrappedB64, "base64");
    const tag = Buffer.from(wrapped.tagB64, "base64");
    const manuallyUnwrapped = aeadDecrypt(
      kek,
      iv,
      ciphertext,
      tag,
      Buffer.from(EXPECTED_DEK_WRAP_AAD),
    );
    expect(manuallyUnwrapped.equals(dek)).toBe(true);
  });

  // Same idea but the negative: a WRONG AAD must fail to decrypt. Catches the
  // mutation that replaces the constant with `""` (which would still round-trip
  // wrap → unwrap because both ends mutate together).
  it("wrapped DEK fails to decrypt with the wrong AAD", () => {
    const kek = KEK();
    const wrapped = wrapDek(kek, newDek(), 1);
    const iv = Buffer.from(wrapped.ivB64, "base64");
    const ciphertext = Buffer.from(wrapped.wrappedB64, "base64");
    const tag = Buffer.from(wrapped.tagB64, "base64");
    expect(() =>
      aeadDecrypt(kek, iv, ciphertext, tag, Buffer.from("wrong-aad")),
    ).toThrow();
  });

  // Specifically the empty-AAD case (matches the Stryker mutation).
  it("wrapped DEK fails to decrypt with empty AAD", () => {
    const kek = KEK();
    const wrapped = wrapDek(kek, newDek(), 1);
    const iv = Buffer.from(wrapped.ivB64, "base64");
    const ciphertext = Buffer.from(wrapped.wrappedB64, "base64");
    const tag = Buffer.from(wrapped.tagB64, "base64");
    expect(() => aeadDecrypt(kek, iv, ciphertext, tag, Buffer.alloc(0))).toThrow();
  });
});
