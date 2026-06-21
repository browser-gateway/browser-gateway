import { aeadDecrypt, aeadEncrypt, generateDek } from "./encryption.js";
import { type WrappedDek } from "./types.js";

const DEK_WRAP_AAD = Buffer.from("browser-gateway:dek-wrap:v1");

export function wrapDek(kek: Buffer, dek: Buffer, version: number): WrappedDek {
  const parts = aeadEncrypt(kek, dek, DEK_WRAP_AAD);
  return {
    version,
    wrappedB64: parts.ciphertext.toString("base64"),
    ivB64: parts.iv.toString("base64"),
    tagB64: parts.tag.toString("base64"),
  };
}

export function unwrapDek(kek: Buffer, wrapped: WrappedDek): Buffer {
  return aeadDecrypt(
    kek,
    Buffer.from(wrapped.ivB64, "base64"),
    Buffer.from(wrapped.wrappedB64, "base64"),
    Buffer.from(wrapped.tagB64, "base64"),
    DEK_WRAP_AAD,
  );
}

export function newDek(): Buffer {
  return generateDek();
}
