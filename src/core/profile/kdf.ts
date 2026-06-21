import { scryptSync, randomBytes, createHash } from "node:crypto";
import { DEFAULT_KDF_PARAMS, type KdfParams } from "./types.js";

const MIN_PASSWORD_LENGTH = 32;

export function newKdfParams(overrides?: Partial<KdfParams>): KdfParams {
  const salt = randomBytes(16).toString("base64");
  return {
    ...DEFAULT_KDF_PARAMS,
    ...overrides,
    saltB64: overrides?.saltB64 ?? salt,
  };
}

export function deriveKek(password: string, params: KdfParams): Buffer {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `BG_ENCRYPTION_KEY must be at least ${MIN_PASSWORD_LENGTH} characters of high-entropy input (e.g., base64-encoded 32 random bytes)`,
    );
  }
  if (params.algorithm !== "scrypt") {
    throw new Error(`unsupported KDF algorithm: ${params.algorithm}`);
  }
  const salt = Buffer.from(params.saltB64, "base64");
  if (salt.length === 0) {
    throw new Error("KDF salt must be non-empty");
  }
  return scryptSync(password, salt, params.keyLen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024,
  });
}

export function kekFingerprint(kek: Buffer): string {
  return createHash("blake2b512").update(kek).digest().subarray(0, 16).toString("base64");
}
