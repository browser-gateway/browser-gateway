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

  // Boundary tests — distinguish `<` from `<=` and `>` from `>=` for the
  // dekVersion range check. Without these a mutation could shift the
  // boundaries undetected.
  it("accepts dekVersion at the inclusive lower bound (1)", () => {
    expect(() => encodeBlob(newDek(), 1, Buffer.from("x"), "p")).not.toThrow();
  });

  it("accepts dekVersion at the inclusive upper bound (255)", () => {
    expect(() => encodeBlob(newDek(), 255, Buffer.from("x"), "p")).not.toThrow();
  });

  // The decodeBlobHeader path has its own dekVersion >= 1 check. Encoding
  // refuses 0, so we craft a blob with dekVersion=0 written directly into the
  // header bytes to exercise the decode-side guard.
  it("decodeBlobHeader rejects blobs with dekVersion=0 written into the header", () => {
    const dek = newDek();
    const { bytes } = encodeBlob(dek, 1, Buffer.from("x"), "p");
    bytes.writeUInt8(0, 6); // header byte 6 = dekVersion field
    expect(() => decodeBlobHeader(bytes)).toThrow(/dekVersion/);
  });

  // Boundary test for the AAD truncation check (`blob.length < aadEnd`). The
  // existing "rejects truncated AAD" test only covers `blob.length < aadEnd`.
  // This one verifies the no-ciphertext edge case (`blob.length === aadEnd`)
  // is accepted at the header level, distinguishing `<` from `<=`.
  it("decodeBlobHeader accepts a blob whose length equals header+AAD (no ciphertext)", () => {
    const dek = newDek();
    const { bytes } = encodeBlob(dek, 1, Buffer.from("plain"), "longer-id-name");
    // Compute aadEnd from the header and truncate to exactly that.
    const header = decodeBlobHeader(bytes);
    const aadEnd = HEADER_LEN + header.aad.length;
    const exactBoundary = bytes.subarray(0, aadEnd);
    // Header decode should succeed even with zero ciphertext.
    expect(() => decodeBlobHeader(exactBoundary)).not.toThrow();
    const header2 = decodeBlobHeader(exactBoundary);
    expect(header2.ciphertext.length).toBe(0);
  });

  // Distinguish `blob.length < HEADER_LEN` from `<=`. The existing test passes
  // HEADER_LEN - 1. This one passes exactly HEADER_LEN.
  it("decodeBlobHeader accepts a blob whose length equals exactly HEADER_LEN", () => {
    // A blob exactly HEADER_LEN bytes with valid magic + version + alg + dekVersion
    // and aadLen=0. Will likely fail later in AAD parsing, but the "too small" guard
    // must NOT trip.
    const buf = Buffer.alloc(HEADER_LEN);
    MAGIC.copy(buf, 0);
    buf.writeUInt8(1, 4);  // version
    buf.writeUInt8(0x01, 5); // alg
    buf.writeUInt8(1, 6);  // dekVersion
    buf.writeUInt32LE(0, 36); // aadLen=0
    expect(() => decodeBlobHeader(buf)).not.toThrow(/too small/);
  });
});
