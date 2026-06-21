import { aeadDecrypt, aeadEncrypt } from "./encryption.js";

export const MAGIC = Buffer.from("BGP1");
export const BLOB_VERSION = 1;
export const ALG_AES_256_GCM = 0x01;
export const HEADER_LEN = 44;

export interface EncodedBlob {
  bytes: Buffer;
  totalLen: number;
}

export interface DecodedHeader {
  version: number;
  alg: number;
  dekVersion: number;
  iv: Buffer;
  authTag: Buffer;
  aad: Buffer;
  ciphertext: Buffer;
}

export function encodeBlob(
  dek: Buffer,
  dekVersion: number,
  plaintext: Buffer,
  profileId: string,
): EncodedBlob {
  if (dekVersion < 1 || dekVersion > 255) {
    throw new Error(`dekVersion out of range: ${dekVersion}`);
  }
  const aad = Buffer.from(profileId, "utf8");
  const { iv, ciphertext, tag } = aeadEncrypt(dek, plaintext, aad);

  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header.writeUInt8(BLOB_VERSION, 4);
  header.writeUInt8(ALG_AES_256_GCM, 5);
  header.writeUInt8(dekVersion, 6);
  header.writeUInt8(0, 7);
  iv.copy(header, 8);
  tag.copy(header, 20);
  header.writeUInt32LE(aad.length, 36);
  header.writeUInt32LE(0, 40);

  const bytes = Buffer.concat([header, aad, ciphertext]);
  return { bytes, totalLen: bytes.length };
}

export function decodeBlobHeader(blob: Buffer): DecodedHeader {
  if (blob.length < HEADER_LEN) {
    throw new Error(`blob too small (${blob.length} < ${HEADER_LEN})`);
  }
  if (!blob.subarray(0, 4).equals(MAGIC)) {
    throw new Error(`not a browser-gateway profile blob: magic mismatch`);
  }
  const version = blob.readUInt8(4);
  if (version !== BLOB_VERSION) {
    throw new Error(`unsupported blob version: ${version}`);
  }
  const alg = blob.readUInt8(5);
  if (alg !== ALG_AES_256_GCM) {
    throw new Error(`unsupported alg: 0x${alg.toString(16)}`);
  }
  const dekVersion = blob.readUInt8(6);
  if (dekVersion < 1) {
    throw new Error(`invalid dekVersion: ${dekVersion}`);
  }
  const iv = blob.subarray(8, 20);
  const authTag = blob.subarray(20, 36);
  const aadLen = blob.readUInt32LE(36);

  const aadStart = HEADER_LEN;
  const aadEnd = aadStart + aadLen;
  if (blob.length < aadEnd) {
    throw new Error(`blob truncated: declared AAD length ${aadLen} exceeds remaining bytes`);
  }
  const aad = blob.subarray(aadStart, aadEnd);
  const ciphertext = blob.subarray(aadEnd);

  return { version, alg, dekVersion, iv, authTag, aad, ciphertext };
}

export function decodeBlob(blob: Buffer, dek: Buffer, expectedProfileId: string): Buffer {
  const header = decodeBlobHeader(blob);
  const aadStr = header.aad.toString("utf8");
  if (aadStr !== expectedProfileId) {
    throw new Error(
      `profile id mismatch: blob AAD is "${aadStr}" but expected "${expectedProfileId}" (possible swap attack)`,
    );
  }
  return aeadDecrypt(dek, header.iv, header.ciphertext, header.authTag, header.aad);
}
