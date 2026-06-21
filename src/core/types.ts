import { z } from "zod";
import { PoolConfigSchema } from "./pool/types.js";

export const ProviderConfigSchema = z.object({
  url: z.string().url(),
  limits: z
    .object({
      maxConcurrent: z.number().int().positive().optional(),
    })
    .optional(),
  priority: z.number().int().positive().default(1),
  weight: z.number().int().positive().default(1),
});

const CooldownSchema = z.object({
  defaultMs: z.number().int().default(30000),
  failureThreshold: z.number().default(0.5),
  minRequestVolume: z.number().int().default(3),
});

const SessionsSchema = z.object({
  idleTimeoutMs: z.number().int().default(300000),
  reconnectTimeoutMs: z.number().int().default(300000),
});

const QueueSchema = z.object({
  maxSize: z.number().int().default(50),
  timeoutMs: z.number().int().default(30000),
});

const GatewaySettingsSchema = z.object({
  port: z.number().int().default(9500),
  defaultStrategy: z
    .enum(["priority-chain", "round-robin", "least-connections", "latency-optimized", "weighted"])
    .default("priority-chain"),
  healthCheckInterval: z.number().int().default(30000),
  connectionTimeout: z.number().int().default(10000),
  shutdownDrainMs: z.number().int().default(30000),
  cooldown: CooldownSchema.default(() => CooldownSchema.parse({})),
  sessions: SessionsSchema.default(() => SessionsSchema.parse({})),
  queue: QueueSchema.default(() => QueueSchema.parse({})),
});

const DashboardSchema = z.object({
  enabled: z.boolean().default(true),
});

const LoggingSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const WebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).optional(),
});

const ProfilesFilesystemSchema = z.object({
  path: z.string().default("./profiles"),
});

const ProfilesEncryptionSchema = z.object({
  keyEnv: z.string().default("BG_ENCRYPTION_KEY"),
});

export const ProfilesConfigSchema = z.object({
  enabled: z.boolean().default(false),
  store: z.enum(["filesystem"]).default("filesystem"),
  filesystem: ProfilesFilesystemSchema.default(() => ProfilesFilesystemSchema.parse({})),
  encryption: ProfilesEncryptionSchema.default(() => ProfilesEncryptionSchema.parse({})),
  lockTtlMs: z.number().int().default(5 * 60_000),
  /** Timeout for the inject path (open WS + Storage.setCookies). */
  cdpTimeoutMs: z.number().int().default(10_000),
  /**
   * Timeout for the commit path (capture + write). Defaults to a SHORTER 4s so the
   * profile lock releases sooner after disconnect — important for rapid-reconnect
   * agent workflows (M1). If your provider is slow on Storage.getCookies, raise this.
   */
  commitTimeoutMs: z.number().int().default(4_000),
});

export type ProfilesConfig = z.infer<typeof ProfilesConfigSchema>;

export const GatewayConfigSchema = z.object({
  version: z.number().default(1),
  gateway: GatewaySettingsSchema.default(() => GatewaySettingsSchema.parse({})),
  providers: z.record(z.string(), ProviderConfigSchema),
  pool: PoolConfigSchema.default(() => PoolConfigSchema.parse({})),
  webhooks: z.array(WebhookSchema).default([]),
  dashboard: DashboardSchema.default(() => DashboardSchema.parse({})),
  logging: LoggingSchema.default(() => LoggingSchema.parse({})),
  profiles: ProfilesConfigSchema.default(() => ProfilesConfigSchema.parse({})),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export interface ProviderState {
  id: string;
  config: ProviderConfig;
  active: number;
  healthy: boolean;
  cooldownUntil: number | null;
  failureCount: number;
  successCount: number;
  lastFailure: number | null;
  avgLatencyMs: number;
  totalConnections: number;
}

export interface Session {
  id: string;
  providerId: string;
  connectedAt: number;
  lastActivity: number;
  messageCount: number;
}
