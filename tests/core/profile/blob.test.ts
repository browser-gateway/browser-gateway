import { describe, expect, it } from "vitest";
import {
  decodeBlob,
  decodeBlobHeader,
  encodeBlob,
  HEADER_LEN,
  MAGIC,
} from "../../../src/core/profile/blob.js";
import { newDek } from "../../../src/core/profile/envelope.js";

describe("blob (BGP1 binary format)", () => {
  it("round-trips a plaintext through encode/decode", () => {
    const dek = newDek();
    const plain = Buffer.from(JSON.stringify({ cookies: [{ name: "session", value: "abc" }] }));
    const { bytes } = encodeBlob(dek, 1, plain, "acme-prod");
    const back = decodeBlob(bytes, dek, "acme-prod");
    expect(back.equals(plain)).toBe(true);
  });

  it("encodes header with correct magic, version, alg, dekVersion", () => {
    const dek = newDek();
    const { bytes } = encodeBlob(dek, 3, Buffer.from("x"), "p1");
    expect(bytes.subarray(0, 4).equals(MAGIC)).toBe(true);
    const header = decodeBlobHeader(bytes);
    expect(header.version).toBe(1);
    expect(header.alg).toBe(0x01);
    expect(header.dekVersion).toBe(3);
    expect(header.iv.length).toBe(12);
    expect(header.authTag.length).toBe(16);
  });

  it("rejects blobs smaller than the header", () => {
    expect(() => decodeBlobHeader(Buffer.alloc(HEADER_LEN - 1))).toThrow(/too small/);
  });

  it("rejects wrong magic bytes", () => {
    const bad = Buffer.alloc(HEADER_LEN + 4);
    bad.write("XXXX", 0);
    expect(() => decodeBlobHeader(bad)).toThrow(/magic/);
  });

  it("rejects unsupported version", () => {
    const dek = newDek();
    const { bytes } = encodeBlob(dek, 1, Buffer.from("x"), "p");
    bytes.writeUInt8(99, 4);
    expect(() => decodeBlobHeader(bytes)).toThrow(/version/);
  });

  it("rejects unsupported algorithm", () => {
    const dek = newDek();
    const { bytes } = encodeBlob(dek, 1, Buffer.from("x"), "p");
    bytes.writeUInt8(0x99, 5);
    expect(() => decodeBlobHeader(bytes)).toThrow(/alg/);
  });

  it("rejects truncated AAD", () => {
    const dek = newDek();
    const { bytes } = encodeBlob(dek, 1, Buffer.from("plain"), "longer-id-name");
    const truncated = bytes.subarray(0, HEADER_LEN + 2);
    expect(() => decodeBlobHeader(truncated)).toThrow(/truncated/);
  });

  it("detects swap attack (different AAD on decrypt)", () => {
    const dek = newDek();
    const { bytes } = encodeBlob(dek, 1, Buffer.from("secret"), "acme-prod");
    expect(() => decodeBlob(bytes, dek, "acme-staging")).toThrow(/swap/);
  });

  it("fails to decrypt with wrong DEK", () => {
    const dek1 = newDek();
    const dek2 = newDek();
    const { bytes } = encodeBlob(dek1, 1, Buffer.from("secret"), "p");
    expect(() => decodeBlob(bytes, dek2, "p")).toThrow();
  });

  it("rejects dekVersion out of range", () => {
    expect(() => encodeBlob(newDek(), 0, Buffer.from("x"), "p")).toThrow();
    expect(() => encodeBlob(newDek(), 256, Buffer.from("x"), "p")).toThrow();
  });
});
