import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { aeadDecrypt, aeadEncrypt, generateDek } from "../../../src/core/profile/encryption.js";

describe("encryption (AES-256-GCM AEAD)", () => {
  it("round-trips plaintext", () => {
    const key = generateDek();
    const plaintext = Buffer.from("hello browser-gateway", "utf8");
    const { iv, ciphertext, tag } = aeadEncrypt(key, plaintext);
    const back = aeadDecrypt(key, iv, ciphertext, tag);
    expect(back.equals(plaintext)).toBe(true);
  });

  it("round-trips with AAD", () => {
    const key = generateDek();
    const aad = Buffer.from("acme-prod", "utf8");
    const plaintext = Buffer.from("cookie-jar");
    const { iv, ciphertext, tag } = aeadEncrypt(key, plaintext, aad);
    const back = aeadDecrypt(key, iv, ciphertext, tag, aad);
    expect(back.equals(plaintext)).toBe(true);
  });

  it("fails to decrypt with wrong key", () => {
    const k1 = generateDek();
    const k2 = generateDek();
    const { iv, ciphertext, tag } = aeadEncrypt(k1, Buffer.from("x"));
    expect(() => aeadDecrypt(k2, iv, ciphertext, tag)).toThrow();
  });

  it("fails to decrypt with tampered ciphertext", () => {
    const key = generateDek();
    const { iv, ciphertext, tag } = aeadEncrypt(key, Buffer.from("hello"));
    ciphertext[0] ^= 0xff;
    expect(() => aeadDecrypt(key, iv, ciphertext, tag)).toThrow();
  });

  it("fails to decrypt with tampered tag", () => {
    const key = generateDek();
    const { iv, ciphertext, tag } = aeadEncrypt(key, Buffer.from("hello"));
    tag[0] ^= 0xff;
    expect(() => aeadDecrypt(key, iv, ciphertext, tag)).toThrow();
  });

  it("fails to decrypt with wrong AAD", () => {
    const key = generateDek();
    const { iv, ciphertext, tag } = aeadEncrypt(key, Buffer.from("hello"), Buffer.from("a"));
    expect(() => aeadDecrypt(key, iv, ciphertext, tag, Buffer.from("b"))).toThrow();
  });

  it("uses a fresh IV per call", () => {
    const key = generateDek();
    const a = aeadEncrypt(key, Buffer.from("same"));
    const b = aeadEncrypt(key, Buffer.from("same"));
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it("rejects keys of wrong length", () => {
    expect(() => aeadEncrypt(randomBytes(16), Buffer.from("x"))).toThrow(/32 bytes/);
    expect(() => aeadDecrypt(randomBytes(16), randomBytes(12), Buffer.from("x"), randomBytes(16))).toThrow(/32 bytes/);
  });

  it("rejects IV of wrong length on decrypt", () => {
    const key = generateDek();
    expect(() => aeadDecrypt(key, randomBytes(8), Buffer.from("x"), randomBytes(16))).toThrow(/iv/);
  });

  it("rejects tag of wrong length on decrypt", () => {
    const key = generateDek();
    expect(() => aeadDecrypt(key, randomBytes(12), Buffer.from("x"), randomBytes(8))).toThrow(/tag/);
  });

  it("generateDek returns 32 fresh bytes", () => {
    const a = generateDek();
    const b = generateDek();
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(a.equals(b)).toBe(false);
  });
});
