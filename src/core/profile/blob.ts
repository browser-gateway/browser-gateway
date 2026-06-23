import { gzipSync, gunzipSync } from "node:zlib";
import { aeadDecrypt, aeadEncrypt } from "./encryption.js";

export const MAGIC = Buffer.from("BGP1");
/**
 * Blob version. v1 = uncompressed plaintext, v2 = plaintext is gzipped before
 * AES-GCM. Header byte 7 carries the compression alg when version === 2.
 * Bumping the version lets old code refuse v2 cleanly instead of silently
 * mis-parsing gzip bytes as JSON.
 */
export const BLOB_VERSION = 2;
export const BLOB_VERSION_V1 = 1;
export const ALG_AES_256_GCM = 0x01;
export const HEADER_LEN = 44;
export const COMPRESS_NONE = 0x00;
export const COMPRESS_GZIP = 0x01;

export interface EncodedBlob {
  bytes: Buffer;
  totalLen: number;
}

export interface DecodedHeader {
  version: number;
  alg: number;
  dekVersion: number;
  /** Byte 7. For v2 = compression algorithm (COMPRESS_NONE / COMPRESS_GZIP). For v1 = unused (always 0). */
  compression: number;
  iv: Buffer;
  authTag: Buffer;
  aad: Buffer;
  ciphertext: Buffer;
}

export interface EncodeBlobOptions {
  /**
   * Compress plaintext with gzip before AES-GCM. Default true (the v2 norm).
   * Pass false to write a v1-compatible uncompressed blob.
   */
  compress?: boolean;
}

export function encodeBlob(
  dek: Buffer,
  dekVersion: number,
  plaintext: Buffer,
  profileId: string,
  opts: EncodeBlobOptions = {},
): EncodedBlob {
  if (dekVersion < 1 || dekVersion > 255) {
    throw new Error(`dekVersion out of range: ${dekVersion}`);
  }
  const compress = opts.compress ?? true;
  const body = compress ? gzipSync(plaintext) : plaintext;
  const blobVersion = compress ? BLOB_VERSION : BLOB_VERSION_V1;
  const compressionByte = compress ? COMPRESS_GZIP : COMPRESS_NONE;

  const aad = Buffer.from(profileId, "utf8");
  const { iv, ciphertext, tag } = aeadEncrypt(dek, body, aad);

  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header.writeUInt8(blobVersion, 4);
  header.writeUInt8(ALG_AES_256_GCM, 5);
  header.writeUInt8(dekVersion, 6);
  header.writeUInt8(compressionByte, 7);
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
  if (version !== BLOB_VERSION && version !== BLOB_VERSION_V1) {
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
  // v2 stores compression byte at position 7; v1 always wrote 0 here.
  const compression = version === BLOB_VERSION ? blob.readUInt8(7) : COMPRESS_NONE;
  if (compression !== COMPRESS_NONE && compression !== COMPRESS_GZIP) {
    throw new Error(`unsupported compression: 0x${compression.toString(16)}`);
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

  return { version, alg, dekVersion, compression, iv, authTag, aad, ciphertext };
}

export function decodeBlob(blob: Buffer, dek: Buffer, expectedProfileId: string): Buffer {
  const header = decodeBlobHeader(blob);
  const aadStr = header.aad.toString("utf8");
  if (aadStr !== expectedProfileId) {
    throw new Error(
      `profile id mismatch: blob AAD is "${aadStr}" but expected "${expectedProfileId}" (possible swap attack)`,
    );
  }
  const decrypted = aeadDecrypt(dek, header.iv, header.ciphertext, header.authTag, header.aad);
  // v1 blobs and v2-with-COMPRESS_NONE are returned as-is. v2-with-gzip
  // gets decompressed transparently. Older callers don't need to change.
  return header.compression === COMPRESS_GZIP ? gunzipSync(decrypted) : decrypted;
}
