/**
 * Default GatewayConfig builder for the MCP "stdio" / "zero-config" code paths
 * in `index.ts` and `local-chrome.ts`.
 *
 * Both files construct a GatewayConfig with the same defaults — only the
 * `providers` field differs. Extracting that here keeps the defaults in one
 * place so they can't drift.
 */
import { ProfilesConfigSchema, ReplayConfigSchema, type GatewayConfig, type ProviderConfig } from "../../core/types.js";

export function buildMcpGatewayConfig(
  port: number,
  providers: Record<string, ProviderConfig>,
): GatewayConfig {
  return {
    version: 1,
    gateway: {
      port,
      defaultStrategy: "priority-chain",
      healthCheckInterval: 30000,
      connectionTimeout: 10000,
      shutdownDrainMs: 30000,
      cooldown: { defaultMs: 30000, failureThreshold: 0.5, minRequestVolume: 3 },
      sessions: { idleTimeoutMs: 300000, reconnectTimeoutMs: 300000 },
      queue: { maxSize: 20, timeoutMs: 30000 },
    },
    providers,
    pool: {
      minSessions: 0,
      maxSessions: 5,
      maxPagesPerSession: 10,
      retireAfterPages: 100,
      retireAfterMs: 3600000,
      idleTimeoutMs: 300000,
      pageTimeoutMs: 30000,
    },
    webhooks: [],
    dashboard: { enabled: false },
    logging: { level: "info" },
    profiles: ProfilesConfigSchema.parse({}),
    replay: ReplayConfigSchema.parse({}),
  };
}
