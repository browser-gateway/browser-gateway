/**
 * One-click enable flow for the profiles feature.
 *
 * Appends a `profiles:` block to the loaded `gateway.yml`. The encryption key
 * is auto-resolved at runtime (env var → data-dir file → generated), so the
 * wizard no longer touches `.env` and no longer prompts the user for a key.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface EnableProfilesInput {
  /** Path to gateway.yml on disk. From `loadedConfigPath` in config/loader.ts. */
  configPath: string;
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

export function enableProfilesFlow(input: EnableProfilesInput): EnableProfilesResult {
  const { configPath } = input;

  let configWritten = false;
  let configAlreadyHadBlock = false;
  try {
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
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot write gateway.yml at ${configPath}: ${reason}. Set BG_DATA_DIR to a writable path or mount gateway.yml with write permission.`,
      { cause: err },
    );
  }

  return {
    configPath,
    configWritten,
    configAlreadyHadBlock,
    restartRequired: configWritten,
  };
}
