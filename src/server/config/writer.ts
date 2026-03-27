import { writeFileSync, copyFileSync, existsSync } from "node:fs";
import { stringify } from "yaml";
import type { GatewayConfig } from "../../core/types.js";
import { loadedConfigPath } from "./loader.js";

export function writeConfig(config: GatewayConfig, configPath?: string): void {
  const path = configPath ?? loadedConfigPath ?? "./gateway.yml";

  if (existsSync(path)) {
    copyFileSync(path, `${path}.backup`);
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
    providers: {} as Record<string, unknown>,
    dashboard: config.dashboard,
    logging: config.logging,
  };

  for (const [id, provider] of Object.entries(config.providers)) {
    const entry: Record<string, unknown> = { url: provider.url };
    if (provider.limits?.maxConcurrent) {
      entry.limits = { maxConcurrent: provider.limits.maxConcurrent };
    }
    if (provider.priority !== 1) {
      entry.priority = provider.priority;
    }
    (output.providers as Record<string, unknown>)[id] = entry;
  }

  writeFileSync(path, stringify(output, { lineWidth: 120 }), "utf-8");
}
