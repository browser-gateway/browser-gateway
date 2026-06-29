import { openSync, writeSync, fsyncSync, closeSync, copyFileSync, existsSync } from "node:fs";
import { stringify } from "yaml";
import type { GatewayConfig } from "../../core/types.js";
import { loadedConfigPath } from "./loader.js";

export function writeConfig(config: GatewayConfig, configPath?: string): void {
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
    providers[id] = entry;
  }

  const output: Record<string, unknown> = {
    version: config.version,
    gateway: {
      port: config.gateway.port,
      defaultStrategy: config.gateway.defaultStrategy,
      connectionTimeout: config.gateway.connectionTimeout,
      healthCheckInterval: config.gateway.healthCheckInterval,
      cooldown: config.gateway.cooldown,
      sessions: config.gateway.sessions,
    },
    providers,
    dashboard: config.dashboard,
    logging: config.logging,
  };

  if (config.webhooks.length > 0) {
    output.webhooks = config.webhooks;
  }
  output.profiles = config.profiles;
  output.replay = config.replay;

  const yaml = stringify(output, { lineWidth: 120 });
  const fd = openSync(path, "w");
  try {
    writeSync(fd, yaml);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
