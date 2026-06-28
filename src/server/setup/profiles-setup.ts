/**
 * One-click enable flow for the profiles feature.
 *
 * Two-sided update so the change survives a subsequent `writeConfig` call:
 *
 *   1. Disk: `${configPath}` gains a `profiles:` block (durable fsync write).
 *   2. Memory: the live `gateway.config.profiles` object is flipped to enabled
 *      so the next provider edit doesn't serialize an `enabled: false` back to
 *      disk and wipe the new block.
 *
 * The encryption key is auto-resolved at runtime (env var → data-dir file →
 * generated), so the wizard no longer touches `.env` and no longer prompts
 * the user for a key.
 */
import { openSync, readFileSync, writeSync, fsyncSync, closeSync, existsSync } from "node:fs";
import type { GatewayConfig } from "../../core/types.js";

export interface EnableProfilesInput {
  /** Path to gateway.yml on disk. From `loadedConfigPath` in config/loader.ts. */
  configPath: string;
  /**
   * Live gateway config object — flipped in place when the file is written so
   * `writeConfig` doesn't later round-trip a stale `enabled: false`.
   * Optional for unit tests that don't have a Gateway instance.
   */
  config?: GatewayConfig;
}

export interface EnableProfilesResult {
  configPath: string;
  configWritten: boolean;
  configAlreadyHadBlock: boolean;
  /** True if the gateway.yml changed — UI shows the restart hint. */
  restartRequired: boolean;
}

const PROFILES_BLOCK = `
# Added by browser-gateway dashboard "Enable Profiles" wizard.
# The encryption key is auto-managed under BG_DATA_DIR/.encryption-key on
# first start. Override with BG_ENCRYPTION_KEY in the container env if you
# manage secrets centrally (Vault, AWS Secrets Manager, etc.).
profiles:
  enabled: true
  filesystem:
    path: ./profiles
  encryption:
    keyEnv: BG_ENCRYPTION_KEY
`;

/**
 * Write to disk with explicit fsync so the container can be killed (Railway
 * SIGTERM → SIGKILL window) without losing the write.
 */
function writeDurably(path: string, contents: string): void {
  const fd = openSync(path, "w");
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function enableProfilesFlow(input: EnableProfilesInput): EnableProfilesResult {
  const { configPath, config } = input;

  let configWritten = false;
  let configAlreadyHadBlock = false;
  try {
    if (existsSync(configPath)) {
      const yamlText = readFileSync(configPath, "utf-8");
      if (/^profiles:/m.test(yamlText)) {
        configAlreadyHadBlock = true;
      } else {
        const sep = yamlText.length === 0 || yamlText.endsWith("\n") ? "" : "\n";
        writeDurably(configPath, yamlText + sep + PROFILES_BLOCK);
        configWritten = true;
      }
    } else {
      writeDurably(configPath, PROFILES_BLOCK.trimStart());
      configWritten = true;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot write gateway.yml at ${configPath}: ${reason}. Set BG_DATA_DIR to a writable path or mount gateway.yml with write permission.`,
      { cause: err },
    );
  }

  // Mirror the disk change into the in-memory config so the next writeConfig
  // call (triggered by a provider edit, for example) doesn't overwrite the
  // freshly-written profiles block with a stale `enabled: false`.
  if (config && configWritten) {
    config.profiles.enabled = true;
  }

  return {
    configPath,
    configWritten,
    configAlreadyHadBlock,
    restartRequired: configWritten,
  };
}
