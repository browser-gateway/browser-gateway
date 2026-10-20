import { PROFILE_ID_REGEX } from "../core/profile/types.js";
import { isDirectBrowserProxy, parseProxyUrl, RESERVED_NONE_NAME } from "../core/proxy-config.js";
import { SessionDefaultsSchema, type SessionDefaults } from "../core/session-defaults.js";
import type { GatewayConfig } from "../core/types.js";
import { formatZodErrors } from "./validation.js";

type Parsed<T> = { data: T; errors?: undefined } | { data?: undefined; errors: string[] };

/** Validates a full session-defaults body against what this gateway can apply. */
export function parseSessionDefaultsBody(body: Record<string, unknown>, config: GatewayConfig): Parsed<SessionDefaults> {
  const parsed = SessionDefaultsSchema.strict().safeParse(body);
  if (!parsed.success) return { errors: formatZodErrors(parsed.error) };
  const data = parsed.data;
  const errors: string[] = [];
  if (data.profile !== null) {
    if (!config.profiles.enabled) errors.push("profile: turn on profiles before choosing a default profile");
    else if (!PROFILE_ID_REGEX.test(data.profile) || data.profile.toLowerCase() === RESERVED_NONE_NAME) errors.push("profile: not a valid profile name");
  }
  if (data.proxy !== null) {
    const entry = config.proxies[data.proxy];
    const proxy = entry ? parseProxyUrl(entry.url) : null;
    if (!proxy) errors.push(`proxy: '${data.proxy}' is not configured`);
    else if (!proxy.ok || !isDirectBrowserProxy(proxy.proxy)) errors.push(`proxy: '${data.proxy}' cannot be applied by this gateway`);
  }
  return errors.length ? { errors } : { data };
}

const MIN_TIMEOUT_MS = 1_000;
const MAX_CONNECTION_TIMEOUT_MS = 120_000;
const MIN_HEALTH_CHECK_MS = 5_000;
const MAX_HEALTH_CHECK_MS = 3_600_000;
const MIN_IDLE_MS = 10_000;
const MAX_IDLE_MS = 86_400_000;
const MAX_QUEUE_SIZE = 10_000;
const MAX_QUEUE_WAIT_MS = 600_000;
const MAX_COOLDOWN_MS = 3_600_000;
const MAX_MIN_REQUEST_VOLUME = 1_000;

interface Bound { label: string; min: number; max: number; integer: boolean; seconds?: boolean; percent?: boolean }

const ADVANCED_BOUNDS = {
  connectionTimeout: { label: "Connection timeout", min: MIN_TIMEOUT_MS, max: MAX_CONNECTION_TIMEOUT_MS, integer: true, seconds: true },
  healthCheckInterval: { label: "Health check interval", min: MIN_HEALTH_CHECK_MS, max: MAX_HEALTH_CHECK_MS, integer: true, seconds: true },
  sessionIdleTimeoutMs: { label: "Idle session timeout", min: MIN_IDLE_MS, max: MAX_IDLE_MS, integer: true, seconds: true },
  queueMaxSize: { label: "Queue size", min: 0, max: MAX_QUEUE_SIZE, integer: true },
  queueTimeoutMs: { label: "Queue wait", min: 0, max: MAX_QUEUE_WAIT_MS, integer: true, seconds: true },
  cooldownMs: { label: "Cooldown length", min: MIN_TIMEOUT_MS, max: MAX_COOLDOWN_MS, integer: true, seconds: true },
  cooldownFailureThreshold: { label: "Failure rate", min: 0, max: 1, integer: false, percent: true },
  cooldownMinRequestVolume: { label: "Sessions before a cooldown", min: 1, max: MAX_MIN_REQUEST_VOLUME, integer: true },
} satisfies Record<string, Bound>;

export type AdvancedSettings = Partial<Record<keyof typeof ADVANCED_BOUNDS, number>>;

function describeRange(b: Bound): string {
  if (b.seconds) return `${b.min / 1000} and ${b.max / 1000} seconds`;
  if (b.percent) return `${b.min * 100} and ${b.max * 100} percent`;
  return `${b.min} and ${b.max}`;
}

/** Validates a partial advanced-settings body; every field is optional and bounded. */
export function parseAdvancedSettingsBody(body: Record<string, unknown>): Parsed<AdvancedSettings> {
  const errors: string[] = [];
  const data: AdvancedSettings = {};
  for (const [key, value] of Object.entries(body)) {
    const bound: Bound | undefined = ADVANCED_BOUNDS[key as keyof typeof ADVANCED_BOUNDS];
    if (!bound) {
      errors.push(`${key}: not a setting that can be changed here`);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || (bound.integer && !Number.isInteger(value)) || value < bound.min || value > bound.max) {
      errors.push(`${bound.label} must be between ${describeRange(bound)}`);
      continue;
    }
    data[key as keyof typeof ADVANCED_BOUNDS] = value;
  }
  return errors.length ? { errors } : { data };
}
