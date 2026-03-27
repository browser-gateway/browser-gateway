import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import { GatewayConfigSchema, type GatewayConfig } from "../../core/types.js";

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

export function loadConfig(configPath?: string): GatewayConfig {
  const paths = [
    configPath,
    process.env.BG_CONFIG_PATH,
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
    raw = buildConfigFromEnv();
    loadedConfigPath = configPath ?? "./gateway.yml";
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
      port: parseInt(process.env.BG_PORT ?? "9500", 10),
    },
    providers: {},
  };
}
