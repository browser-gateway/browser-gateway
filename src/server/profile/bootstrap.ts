import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Logger } from "pino";
import type { ProfilesConfig } from "../../core/types.js";
import { FilesystemProfileStore } from "./filesystem-store.js";
import { KEYCHECK_FILE, initStore, openStore } from "./keycheck.js";
import { ProfileLifecycle } from "./lifecycle.js";
import { resolveDataDir } from "../setup/data-dir.js";
import { resolveEncryptionKey } from "../setup/encryption-key.js";

export interface ProfileBootstrap {
  enabled: true;
  lifecycle: ProfileLifecycle;
  store: FilesystemProfileStore;
  storePath: string;
  dekByVersion: ReadonlyMap<number, Buffer>;
  currentDekVersion: number;
}

export interface ProfileBootstrapDisabled {
  enabled: false;
}

export type ProfileBootstrapResult = ProfileBootstrap | ProfileBootstrapDisabled;

export class ProfileBootstrapError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(hint ? `${message}\n\n${hint}` : message);
    this.name = "ProfileBootstrapError";
  }
}

/**
 * Bootstrap the profile subsystem from gateway config.
 *
 * - If profiles.enabled is false, returns { enabled: false } — no work done.
 * - Otherwise: reads BG_ENCRYPTION_KEY (or whatever encryption.keyEnv resolves to),
 *   ensures the store path exists, initializes a fresh .keycheck on first run, or
 *   opens an existing one and validates the key (KCV match).
 *
 * On KCV mismatch (= wrong key), throws ProfileBootstrapError pointing the operator
 * at "browser-gateway profile key rewrap" or instructions to start fresh.
 */
export async function bootstrapProfiles(
  config: ProfilesConfig,
  logger: Logger,
): Promise<ProfileBootstrapResult> {
  if (!config.enabled) {
    logger.debug("profiles: disabled");
    return { enabled: false };
  }

  const resolved = resolveEncryptionKey(logger);
  const password = resolved.value;

  const storePath = resolveStorePath(config.filesystem.path);
  if (!existsSync(storePath)) {
    mkdirSync(storePath, { recursive: true, mode: 0o700 });
  }

  const keycheckPath = `${storePath}/${KEYCHECK_FILE}`;
  const opened = existsSync(keycheckPath)
    ? await openStore(storePath, password).catch((err) => {
        throw new ProfileBootstrapError(
          err instanceof Error ? err.message : String(err),
          `If you intentionally changed the encryption key (env or ${resolved.path ?? "data dir"}), run "browser-gateway profile key rewrap" to migrate.\n` +
            `If you want to start over (DESTROYS PROFILES), delete ${keycheckPath}.`,
        );
      })
    : await initStore(storePath, password).catch((err) => {
        throw new ProfileBootstrapError(
          `failed to initialise profile store at ${storePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

  const store = new FilesystemProfileStore({ storePath });
  const lifecycle = new ProfileLifecycle(
    store,
    opened.dekByVersion,
    opened.currentDekVersion,
    logger,
    {
      lockTtlMs: config.lockTtlMs,
      cdpTimeoutMs: config.cdpTimeoutMs,
      commitTimeoutMs: config.commitTimeoutMs,
    },
  );

  logger.info(
    {
      storePath,
      dekVersions: Array.from(opened.dekByVersion.keys()),
      currentDek: opened.currentDekVersion,
    },
    "profiles: enabled",
  );

  return {
    enabled: true,
    lifecycle,
    store,
    storePath,
    dekByVersion: opened.dekByVersion,
    currentDekVersion: opened.currentDekVersion,
  };
}

/**
 * Resolve the profile store path with `BG_DATA_DIR` env override.
 *
 * Absolute config paths win (operator knows what they want). Relative paths
 * are joined under the resolved data directory — `/data` in Docker,
 * `~/.browser-gateway` outside, or whatever `BG_DATA_DIR` points to.
 */
export function resolveStorePath(configPath: string): string {
  if (isAbsolute(configPath)) return configPath;
  return resolve(resolveDataDir(), configPath);
}
