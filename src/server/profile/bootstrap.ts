import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Logger } from "pino";
import type { ProfilesConfig } from "../../core/types.js";
import { FilesystemProfileStore } from "./filesystem-store.js";
import { KEYCHECK_FILE, initStore, openStore } from "./keycheck.js";
import { ProfileLifecycle } from "./lifecycle.js";

export interface ProfileBootstrap {
  enabled: true;
  lifecycle: ProfileLifecycle;
  store: FilesystemProfileStore;
  storePath: string;
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

  const keyEnv = config.encryption.keyEnv;
  const password = process.env[keyEnv];
  if (!password) {
    throw new ProfileBootstrapError(
      `profiles.enabled is true but ${keyEnv} is not set in the environment`,
      `Generate a strong key with: openssl rand -base64 32\nThen set ${keyEnv}=<value> in your environment.`,
    );
  }

  const storePath = resolve(config.filesystem.path);
  if (!existsSync(storePath)) {
    mkdirSync(storePath, { recursive: true, mode: 0o700 });
  }

  const keycheckPath = `${storePath}/${KEYCHECK_FILE}`;
  const opened = existsSync(keycheckPath)
    ? await openStore(storePath, password).catch((err) => {
        throw new ProfileBootstrapError(
          err instanceof Error ? err.message : String(err),
          `If you intentionally changed ${keyEnv}, run "browser-gateway profile key rewrap" to migrate.\n` +
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

  return { enabled: true, lifecycle, store, storePath };
}
