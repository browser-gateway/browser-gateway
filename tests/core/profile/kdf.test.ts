import { describe, expect, it } from "vitest";
import { deriveKek, kekFingerprint, newKdfParams } from "../../../src/core/profile/kdf.js";

const STRONG_PWD = Buffer.alloc(32, "x").toString("base64");

describe("kdf", () => {
  it("derives a deterministic 32-byte key for same password + params", () => {
    const params = newKdfParams();
    const k1 = deriveKek(STRONG_PWD, params);
    const k2 = deriveKek(STRONG_PWD, params);
    expect(k1.length).toBe(32);
    expect(k1.equals(k2)).toBe(true);
  });

  it("derives a different key when salt changes", () => {
    const a = newKdfParams();
    const b = newKdfParams();
    expect(a.saltB64).not.toBe(b.saltB64);
    const k1 = deriveKek(STRONG_PWD, a);
    const k2 = deriveKek(STRONG_PWD, b);
    expect(k1.equals(k2)).toBe(false);
  });

  it("derives a different key when password changes", () => {
    const params = newKdfParams();
    const other = Buffer.alloc(32, "y").toString("base64");
    const k1 = deriveKek(STRONG_PWD, params);
    const k2 = deriveKek(other, params);
    expect(k1.equals(k2)).toBe(false);
  });

  it("rejects short passwords", () => {
    const params = newKdfParams();
    expect(() => deriveKek("short", params)).toThrow(/at least 32 characters/);
  });

  it("rejects empty salt", () => {
    const params = { ...newKdfParams(), saltB64: "" };
    expect(() => deriveKek(STRONG_PWD, params)).toThrow(/salt/);
  });

  it("rejects unsupported algorithm", () => {
    const params = { ...newKdfParams(), algorithm: "argon2" as unknown as "scrypt" };
    expect(() => deriveKek(STRONG_PWD, params)).toThrow(/unsupported/i);
  });

  it("kekFingerprint is deterministic and 16 bytes base64", () => {
    const k = deriveKek(STRONG_PWD, newKdfParams());
    const fp1 = kekFingerprint(k);
    const fp2 = kekFingerprint(k);
    expect(fp1).toBe(fp2);
    expect(Buffer.from(fp1, "base64").length).toBe(16);
  });
});
