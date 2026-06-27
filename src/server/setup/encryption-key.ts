import { readFileSync, writeFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "pino";
import { resolveDataDir } from "./data-dir.js";

/** Name of the auto-managed key file under `BG_DATA_DIR`. */
const KEY_FILE_NAME = ".encryption-key";

/** Length of the auto-generated key in raw bytes (256 bits). */
const KEY_BYTES = 32;

export interface ResolvedEncryptionKey {
  /** The base64 key string passed downstream to scrypt-KDF. */
  value: string;
  /** Where it came from — used by callers for log lines / dashboard hints. */
  source: "env" | "file" | "generated";
  /** Absolute path the key was loaded from or written to (null for env). */
  path: string | null;
}

/**
 * Resolve the gateway's profile-encryption key. Chain:
 *
 *   1. `BG_ENCRYPTION_KEY` env var (enterprise: Vault, AWS SM, etc.)
 *   2. `${BG_DATA_DIR}/.encryption-key` file (auto-managed, persists across boots)
 *   3. Fresh `crypto.randomBytes(32).toString("base64")`, written to the file
 *      with mode 0600
 *
 * If both env var and file exist with DIFFERENT values, env wins and a warning
 * is logged — profiles encrypted with the file key will then fail to decrypt,
 * and the user is told that explicitly.
 */
export function resolveEncryptionKey(logger?: Logger): ResolvedEncryptionKey {
  const dataDir = resolveDataDir();
  const filePath = join(dataDir, KEY_FILE_NAME);
  const fromEnv = process.env.BG_ENCRYPTION_KEY;
  const fromFile = readKeyFile(filePath);

  if (fromEnv && fromFile && fromEnv !== fromFile) {
    logger?.warn(
      { keyFile: filePath },
      "BG_ENCRYPTION_KEY env var differs from existing key file — env wins. Profiles encrypted with the file key will not be decryptable.",
    );
  }

  if (fromEnv) {
    return { value: fromEnv, source: "env", path: null };
  }

  if (fromFile) {
    return { value: fromFile, source: "file", path: filePath };
  }

  const fresh = randomBytes(KEY_BYTES).toString("base64");
  writeFileSync(filePath, fresh, { encoding: "utf-8", mode: 0o600 });
  // Belt-and-suspenders: in case the umask widened the mode at create time.
  chmodSync(filePath, 0o600);
  logger?.info(
    { keyFile: filePath },
    "encryption: generated new key, persisted to data directory",
  );
  return { value: fresh, source: "generated", path: filePath };
}

function readKeyFile(path: string): string | null {
  if (!existsSync(path)) return null;
  // Reject world-readable key files — alert the operator instead of silently
  // accepting a leaked secret.
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    chmodSync(path, 0o600);
  }
  const raw = readFileSync(path, "utf-8").trim();
  return raw.length > 0 ? raw : null;
}
