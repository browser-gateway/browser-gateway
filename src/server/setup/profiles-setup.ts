/**
 * One-click enable flow for the profiles feature.
 *
 * Writes BG_ENCRYPTION_KEY to the local `.env` and appends a `profiles:` block
 * to the loaded `gateway.yml` so a restart is all the user needs to do. Both
 * writes are idempotent — calling twice does nothing on the second call.
 *
 * Intentionally simple text manipulation rather than YAML parsing + re-emit:
 *   - We APPEND if no `profiles:` block exists. We don't try to merge with one
 *     that does (avoids accidentally clobbering custom paths/keys).
 *   - The .env append is line-based — we leave any existing
 *     `BG_ENCRYPTION_KEY=` line alone so users with a key in 1Password don't
 *     get overwritten.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";

export interface EnableProfilesInput {
  /** Base64-encoded random bytes (32+ bytes recommended). */
  encryptionKey: string;
  /** Path to gateway.yml on disk. From `loadedConfigPath` in config/loader.ts. */
  configPath: string;
  /** Path to .env file. Typically `${process.cwd()}/.env`. */
  envPath: string;
}

export interface EnableProfilesResult {
  envPath: string;
  envWritten: boolean;
  envAlreadyHadKey: boolean;
  configPath: string;
  configWritten: boolean;
  configAlreadyHadBlock: boolean;
  /** Reset to true any time at least one file changed — UI shows the restart hint. */
  restartRequired: boolean;
}

const PROFILES_BLOCK = `
# Added by browser-gateway dashboard "Enable Profiles" wizard.
profiles:
  enabled: true
  filesystem:
    path: ./profiles
  encryption:
    keyEnv: BG_ENCRYPTION_KEY
`;

export function enableProfilesFlow(input: EnableProfilesInput): EnableProfilesResult {
  const { encryptionKey, configPath, envPath } = input;

  if (!/^[A-Za-z0-9+/]+=*$/.test(encryptionKey) || encryptionKey.length < 32) {
    throw new Error("encryptionKey must be base64-encoded and at least 32 characters");
  }

  // .env: idempotent append. We only WRITE if the key isn't already present.
  let envWritten = false;
  let envAlreadyHadKey = false;
  if (existsSync(envPath)) {
    const envText = readFileSync(envPath, "utf-8");
    if (/^BG_ENCRYPTION_KEY=/m.test(envText)) {
      envAlreadyHadKey = true;
    } else {
      const sep = envText.length === 0 || envText.endsWith("\n") ? "" : "\n";
      appendFileSync(envPath, `${sep}BG_ENCRYPTION_KEY="${encryptionKey}"\n`);
      envWritten = true;
    }
  } else {
    writeFileSync(envPath, `BG_ENCRYPTION_KEY="${encryptionKey}"\n`);
    envWritten = true;
  }

  // gateway.yml: idempotent append. If the file already mentions profiles:, we
  // leave it alone so we don't clobber a customized config. If it doesn't
  // exist (zero-config users running purely off env vars), we create a minimal
  // file with just the profiles block — otherwise enabling the feature would
  // be impossible without manually authoring YAML, defeating the wizard.
  let configWritten = false;
  let configAlreadyHadBlock = false;
  if (existsSync(configPath)) {
    const yamlText = readFileSync(configPath, "utf-8");
    if (/^profiles:/m.test(yamlText)) {
      configAlreadyHadBlock = true;
    } else {
      const sep = yamlText.length === 0 || yamlText.endsWith("\n") ? "" : "\n";
      writeFileSync(configPath, yamlText + sep + PROFILES_BLOCK);
      configWritten = true;
    }
  } else {
    writeFileSync(configPath, PROFILES_BLOCK.trimStart());
    configWritten = true;
  }

  return {
    envPath,
    envWritten,
    envAlreadyHadKey,
    configPath,
    configWritten,
    configAlreadyHadBlock,
    restartRequired: envWritten || configWritten,
  };
}
