import { readFileSync, existsSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { parse } from "yaml";
import { GatewayConfigSchema, type GatewayConfig } from "../../core/types.js";
import { resolveDataDir } from "../setup/data-dir.js";
import { resolvePort } from "../setup/port.js";

function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const [varName, defaultValue] = envVar.split(":-");
    return process.env[varName.trim()] ?? defaultValue?.trim() ?? "";
  });
}

function deepInterpolate(obj: unknown): unknown {
  if (typeof obj === "string") return interpolateEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(deepInterpolate);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = deepInterpolate(value);
    }
    return result;
  }
  return obj;
}

export let loadedConfigPath: string | null = null;

/**
 * The dashboard's config editor and the add-provider flow both read and
 * write this file, so it must live somewhere writable. `BG_DATA_DIR` is
 * pinned to `/data` in Docker, `~/.browser-gateway` outside, so the file
 * follows the data volume by default. Operators with custom layouts can
 * override via `BG_CONFIG_PATH` or the first CLI arg.
 */
function defaultWritableConfigPath(): string {
  return `${resolveDataDir()}/gateway.yml`;
}

export function loadConfig(configPath?: string): GatewayConfig {
  const writable = defaultWritableConfigPath();
  const paths = [
    configPath,
    process.env.BG_CONFIG_PATH,
    writable,
    "./gateway.yml",
    "./gateway.yaml",
  ].filter(Boolean) as string[];

  let raw: Record<string, unknown> | null = null;

  for (const p of paths) {
    if (existsSync(p)) {
      const content = readFileSync(p, "utf-8");
      raw = parse(content) as Record<string, unknown>;
      loadedConfigPath = p;
      break;
    }
  }

  if (!raw) {
    // First run on a fresh data directory — seed a minimal yaml so the
    // dashboard config editor has something to load and edit, instead of
    // showing the user an empty page on a green-field deploy.
    raw = buildConfigFromEnv();
    loadedConfigPath = configPath ?? writable;
    if (loadedConfigPath === writable && !existsSync(writable)) {
      try {
        const fd = openSync(writable, "w");
        try {
          writeSync(fd, "version: 1\nproviders: {}\n");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        // read-only filesystem — the in-memory default still works, dashboard
        // edits will surface the underlying write error to the user.
      }
    }
  }

  const interpolated = deepInterpolate(raw) as Record<string, unknown>;
  const result = GatewayConfigSchema.safeParse(interpolated);

  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  return result.data;
}

function buildConfigFromEnv(): Record<string, unknown> {
  return {
    version: 1,
    gateway: {
      port: resolvePort(undefined) ?? 9500,
    },
    providers: {},
  };
}
