import { z } from "zod";

export const BackendConfigSchema = z.object({
  url: z.string().url(),
  limits: z
    .object({
      maxConcurrent: z.number().int().positive().optional(),
    })
    .optional(),
  priority: z.number().int().positive().default(1),
});

const CooldownSchema = z.object({
  defaultMs: z.number().int().default(30000),
  failureThreshold: z.number().default(0.5),
  minRequestVolume: z.number().int().default(3),
});

const SessionsSchema = z.object({
  idleTimeoutMs: z.number().int().default(300000),
});

const GatewaySettingsSchema = z.object({
  port: z.number().int().default(3000),
  defaultStrategy: z
    .enum(["priority-chain", "round-robin", "least-connections"])
    .default("priority-chain"),
  healthCheckInterval: z.number().int().default(30000),
  connectionTimeout: z.number().int().default(10000),
  cooldown: CooldownSchema.default(() => CooldownSchema.parse({})),
  sessions: SessionsSchema.default(() => SessionsSchema.parse({})),
});

const DashboardSchema = z.object({
  enabled: z.boolean().default(true),
});

const LoggingSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const GatewayConfigSchema = z.object({
  version: z.number().default(1),
  gateway: GatewaySettingsSchema.default(() => GatewaySettingsSchema.parse({})),
  backends: z.record(z.string(), BackendConfigSchema),
  dashboard: DashboardSchema.default(() => DashboardSchema.parse({})),
  logging: LoggingSchema.default(() => LoggingSchema.parse({})),
});

export type BackendConfig = z.infer<typeof BackendConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export interface BackendState {
  id: string;
  config: BackendConfig;
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
  backendId: string;
  connectedAt: number;
  lastActivity: number;
  messageCount: number;
}
