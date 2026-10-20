import { openSync, writeSync, fsyncSync, closeSync, copyFileSync, existsSync } from "node:fs";
import { stringify } from "yaml";
import { RestConfigSchema, type GatewayConfig } from "../../core/types.js";
import { PoolConfigSchema } from "../../core/pool/types.js";
import { loadedConfigPath, loadedEnvTemplates } from "./loader.js";
import { restoreEnvPlaceholders, type EnvTemplates } from "./env-templates.js";

export function writeConfig(config: GatewayConfig, configPath?: string, templates: EnvTemplates = loadedEnvTemplates): void {
  const path = configPath ?? loadedConfigPath ?? "./gateway.yml";

  if (existsSync(path)) {
    copyFileSync(path, `${path}.backup`);
  }

  const providers: Record<string, unknown> = {};
  for (const [id, provider] of Object.entries(config.providers)) {
    const entry: Record<string, unknown> = { url: provider.url };
    if (provider.limits?.maxConcurrent) {
      entry.limits = { maxConcurrent: provider.limits.maxConcurrent };
    }
    if (provider.priority !== 1) {
      entry.priority = provider.priority;
    }
    if (provider.weight !== 1) {
      entry.weight = provider.weight;
    }
    if (provider.profile) {
      entry.profile = provider.profile;
    }
    if (provider.multiProfile) {
      entry.multiProfile = true;
    }
    if (provider.headers && Object.keys(provider.headers).length > 0) {
      entry.headers = provider.headers;
    }
    if (provider.enabled === false) {
      entry.enabled = false;
    }
    if (provider.injectProxy) {
      entry.injectProxy = true;
    }
    providers[id] = entry;
  }

  const output: Record<string, unknown> = {
    version: config.version,
    gateway: {
      port: config.gateway.port,
      defaultStrategy: config.gateway.defaultStrategy,
      connectionTimeout: config.gateway.connectionTimeout,
      healthCheckInterval: config.gateway.healthCheckInterval,
      shutdownDrainMs: config.gateway.shutdownDrainMs,
      cooldown: config.gateway.cooldown,
      sessions: config.gateway.sessions,
      queue: config.gateway.queue,
    },
    providers,
    dashboard: config.dashboard,
    logging: config.logging,
  };

  if (config.webhooks.length > 0) {
    output.webhooks = config.webhooks;
  }
  if (Object.keys(config.proxies).length > 0) {
    output.proxies = config.proxies;
  }
  const defaults = config.sessionDefaults;
  if (defaults.record || defaults.profile || defaults.saveProfile || defaults.proxy) {
    output.sessionDefaults = defaults;
  }
  for (const [key, value, schema] of [
    ["pool", config.pool, PoolConfigSchema],
    ["rest", config.rest, RestConfigSchema],
  ] as const) {
    if (JSON.stringify(value) !== JSON.stringify(schema.parse({}))) output[key] = value;
  }
  output.profiles = config.profiles;
  output.replay = config.replay;

  const yaml = stringify(restoreEnvPlaceholders(output, templates), { lineWidth: 120 });
  const fd = openSync(path, "w");
  try {
    writeSync(fd, yaml);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
