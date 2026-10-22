const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined" && window.location.port === "9501"
    ? "http://localhost:9500"
    : "");

const fetchOpts: RequestInit = { credentials: "include" };

export async function checkAuth(): Promise<{ authenticated: boolean; authRequired: boolean }> {
  const res = await fetch(`${API_BASE}/web/auth/check`, fetchOpts);
  return res.json();
}

export async function login(token: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/web/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    credentials: "include",
  });
  return res.ok;
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/web/logout`, { method: "POST", credentials: "include" });
}

export async function fetchStatus(): Promise<GatewayStatus> {
  const res = await fetch(`${API_BASE}/v1/status`, fetchOpts);
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Status API error: ${res.status}`);
  return res.json();
}

export async function fetchSessions(): Promise<SessionsResponse> {
  const res = await fetch(`${API_BASE}/v1/sessions`, fetchOpts);
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Sessions API error: ${res.status}`);
  return res.json();
}

export async function fetchParkedSessions(): Promise<ParkedSessionsResponse> {
  const res = await fetch(`${API_BASE}/v1/sessions/parked`, fetchOpts);
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Parked sessions API error: ${res.status}`);
  return res.json();
}

export async function fetchProviders(): Promise<ProviderListResponse> {
  const res = await fetch(`${API_BASE}/v1/providers`, fetchOpts);
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Providers API error: ${res.status}`);
  return res.json();
}

export interface ProxySummary {
  name: string;
  server: string | null;
  bypass: string[];
  usable: boolean;
  reason?: string;
  hasCredentials: boolean;
}

export async function fetchProxies(): Promise<{ proxies: ProxySummary[] }> {
  const res = await fetch(`${API_BASE}/v1/proxies`, fetchOpts);
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Proxies API error: ${res.status}`);
  return res.json();
}

export interface ProxyInput {
  address: string;
  bypass?: string[];
  clearCredentials?: boolean;
}

export interface ProxyExit {
  ip: string;
  country: string | null;
  region: string | null;
  city: string | null;
  org: string | null;
  timezone: string | null;
}

export type ProxyCheckResult =
  | ({ ok: true; latencyMs: number } & ProxyExit)
  | { ok: false; error: string; latencyMs: number };

/** Address that reports the caller's public IP and location as JSON. */
export const PROXY_CHECK_URL = "https://ipinfo.io/json";

/** Loads the IP service in a real browser through the proxy and reports what that browser saw. */
export async function checkProxyInBrowser(name: string, provider?: string): Promise<ProxyCheckResult> {
  const start = Date.now();
  const res = await sendJson<{ success?: boolean; error?: string; message?: string; data?: { content?: { text?: string } } }>(
    "POST",
    "/v1/content",
    { url: PROXY_CHECK_URL, proxy: name, formats: ["text"], retries: 0, ...(provider ? { provider } : {}) },
  );
  const latencyMs = Date.now() - start;
  if (!res.success) return { ok: false, error: res.error ?? res.message ?? "the browser check failed", latencyMs };
  try {
    const body = JSON.parse(res.data?.content?.text ?? "") as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" && v ? v : null);
    if (typeof body.ip !== "string") throw new Error("no ip");
    return { ok: true, ip: body.ip, country: text(body.country), region: text(body.region), city: text(body.city), org: text(body.org), timezone: text(body.timezone), latencyMs };
  } catch {
    return { ok: false, error: "the page the browser loaded did not report an IP address", latencyMs };
  }
}

async function sendJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "include",
  });
  if (res.status === 401) throw new AuthError();
  return res.json();
}

type SaveResult = { ok: boolean; error?: string; details?: string[] };

export function addProxy(name: string, data: ProxyInput): Promise<SaveResult> {
  return sendJson("POST", "/v1/proxies", { name, ...data });
}

export function updateProxy(name: string, data: ProxyInput): Promise<SaveResult> {
  return sendJson("PUT", `/v1/proxies/${encodeURIComponent(name)}`, data);
}

export function deleteProxy(name: string): Promise<SaveResult> {
  return sendJson("DELETE", `/v1/proxies/${encodeURIComponent(name)}`);
}

export function testProxy(name: string): Promise<ProxyCheckResult> {
  return sendJson("POST", `/v1/proxies/${encodeURIComponent(name)}/test`);
}

export type CapabilityState = "supported" | "unsupported" | "unknown";
export type CapabilityProbeStatus = "pending" | "probing" | "ready" | "failed";

export interface ProviderCapabilities {
  browserCookies: CapabilityState;
  targetCreate: CapabilityState;
  targetGetTargets: CapabilityState;
  fetchInterception: CapabilityState;
  pageScreencast: CapabilityState;
  targetCreateLatencyMs: number | null;
  probedAt: string;
  probeDurationMs: number;
  errors: string[];
}

export interface ProviderCapabilitiesResponse {
  id: string;
  status: CapabilityProbeStatus;
  capabilities: ProviderCapabilities | null;
}

export async function fetchProviderCapabilities(id: string): Promise<ProviderCapabilitiesResponse> {
  const res = await fetch(`${API_BASE}/v1/providers/${id}/capabilities`, fetchOpts);
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Capabilities API error: ${res.status}`);
  return res.json();
}

export async function revalidateProviderCapabilities(id: string): Promise<ProviderCapabilitiesResponse> {
  const res = await fetch(`${API_BASE}/v1/providers/${id}/capabilities/revalidate`, {
    method: "POST",
    credentials: "include",
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Revalidate API error: ${res.status}`);
  return res.json();
}

export async function addProvider(data: {
  id: string;
  url: string;
  maxConcurrent?: number;
  priority?: number;
  weight?: number;
  profile?: string | null;
  multiProfile?: boolean;
  headers?: Record<string, string>;
  enabled?: boolean;
  injectProxy?: boolean;
}): Promise<{ ok: boolean; error?: string; details?: string[] }> {
  const res = await fetch(`${API_BASE}/v1/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    credentials: "include",
  });
  return res.json();
}

export async function updateProvider(
  id: string,
  data: { url?: string; maxConcurrent?: number; priority?: number; weight?: number; profile?: string | null; multiProfile?: boolean; headers?: Record<string, string>; enabled?: boolean; injectProxy?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/v1/providers/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    credentials: "include",
  });
  return res.json();
}

export async function deleteProvider(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/v1/providers/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  return res.json();
}

export type Strategy = "priority-chain" | "round-robin" | "least-connections" | "latency-optimized" | "weighted";

export interface SessionDefaults {
  record: boolean;
  profile: string | null;
  saveProfile: boolean;
  proxy: string | null;
}

export interface AdvancedSettings {
  connectionTimeout: number;
  healthCheckInterval: number;
  sessionIdleTimeoutMs: number;
  queueMaxSize: number;
  queueTimeoutMs: number;
  cooldownMs: number;
  cooldownFailureThreshold: number;
  cooldownMinRequestVolume: number;
}

export interface GatewaySettings {
  sessionDefaults: SessionDefaults;
  strategy: Strategy;
  advanced: AdvancedSettings;
  profilesEnabled: boolean;
  appliesAfterRestart: (keyof AdvancedSettings)[];
}

export async function fetchSettings(): Promise<GatewaySettings> {
  const res = await fetch(`${API_BASE}/v1/config/settings`, fetchOpts);
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Settings API error: ${res.status}`);
  return res.json();
}

export function saveSessionDefaults(defaults: SessionDefaults): Promise<SaveResult & { sessionDefaults?: SessionDefaults }> {
  return sendJson("PUT", "/v1/config/session-defaults", defaults);
}

export function saveAdvancedSettings(values: Partial<AdvancedSettings>): Promise<SaveResult & { advanced?: AdvancedSettings }> {
  return sendJson("PUT", "/v1/config/advanced", values);
}

export async function setStrategy(strategy: Strategy): Promise<{ ok: boolean; strategy?: string; error?: string; allowed?: string[] }> {
  const res = await fetch(`${API_BASE}/v1/config/strategy`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ strategy }),
    credentials: "include",
  });
  if (res.status === 401) throw new AuthError();
  return res.json();
}

export interface WebhookItem {
  index: number;
  url: string;
  events: string[] | null;
}

export interface WebhookListResponse {
  webhooks: WebhookItem[];
}

export async function fetchWebhooks(): Promise<WebhookListResponse> {
  const res = await fetch(`${API_BASE}/v1/webhooks`, fetchOpts);
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Webhooks API error: ${res.status}`);
  return res.json();
}

export async function addWebhook(data: { url: string; events?: string[] }): Promise<{ ok: boolean; index?: number; error?: string; details?: string[] }> {
  const res = await fetch(`${API_BASE}/v1/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    credentials: "include",
  });
  return res.json();
}

export async function updateWebhook(index: number, data: { url: string; events?: string[] }): Promise<{ ok: boolean; error?: string; details?: string[] }> {
  const res = await fetch(`${API_BASE}/v1/webhooks/${index}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    credentials: "include",
  });
  return res.json();
}

export async function deleteWebhook(index: number): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/v1/webhooks/${index}`, {
    method: "DELETE",
    credentials: "include",
  });
  return res.json();
}

export async function testWebhook(url: string): Promise<{ ok: boolean; status?: number; latencyMs: number; error?: string }> {
  const res = await fetch(`${API_BASE}/v1/webhooks/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    credentials: "include",
  });
  return res.json();
}

export async function testProvider(
  id: string,
  url?: string,
  headers?: Record<string, string>,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const body: Record<string, unknown> = {};
  if (url) body.url = url;
  if (headers && Object.keys(headers).length > 0) body.headers = headers;
  const res = await fetch(`${API_BASE}/v1/providers/${id}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  return res.json();
}

export async function probeProvider(
  url: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
): Promise<{ detectedKind: "browserserve" | "generic"; advertisedMaxConcurrent: number | null }> {
  const body: Record<string, unknown> = { url };
  if (headers && Object.keys(headers).length > 0) body.headers = headers;
  const res = await fetch(`${API_BASE}/v1/providers/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
    signal,
  });
  const data = await res.json() as { detectedKind?: "browserserve" | "generic"; advertisedMaxConcurrent?: number | null; error?: string };
  if (data.error || !data.detectedKind) throw new Error(data.error ?? "probe returned no kind");
  return { detectedKind: data.detectedKind, advertisedMaxConcurrent: data.advertisedMaxConcurrent ?? null };
}

export async function fetchHealth() {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new Error(`Health API error: ${res.status}`);
  return res.json();
}

export async function fetchConfig(): Promise<{ yaml: string; path: string | null; exists: boolean }> {
  const res = await fetch(`${API_BASE}/v1/config`, fetchOpts);
  if (res.status === 401) throw new AuthError();
  return res.json();
}

export async function validateConfig(yaml: string): Promise<{ valid: boolean; errors?: string[]; providerCount?: number }> {
  const res = await fetch(`${API_BASE}/v1/config/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml }),
    credentials: "include",
  });
  return res.json();
}

export async function saveConfig(yaml: string): Promise<{ ok: boolean; error?: string; message?: string; details?: string[] }> {
  const res = await fetch(`${API_BASE}/v1/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml }),
    credentials: "include",
  });
  return res.json();
}

export class AuthError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "AuthError";
  }
}

export interface ProviderStatus {
  id: string;
  healthy: boolean;
  active: number;
  maxConcurrent: number | null;
  maxConcurrentSource: "config" | "discovered" | null;
  detectedKind: "browserserve" | null;
  cooldownUntil: string | null;
  avgLatencyMs: number;
  totalConnections: number;
  priority: number;
}

export interface ProviderConfigItem {
  id: string;
  url: string;
  maxConcurrent: number | null;
  maxConcurrentSource: "config" | "discovered" | null;
  detectedKind: "browserserve" | null;
  priority: number;
  weight: number;
  profile: string | null;
  multiProfile: boolean;
  headers: Record<string, string> | null;
  enabled: boolean;
  injectProxy: boolean;
}

/** Mirror of isEligibleProviderForProfile from src/core/providers/effective.ts. */
export function canSaveToProfile(provider: Pick<ProviderConfigItem, "detectedKind" | "profile">, profileId: string): boolean {
  return provider.detectedKind === "browserserve" || provider.profile == null || provider.profile === profileId;
}

/** Providers the gateway routes to. Disabled ones stay listed but are skipped by pickers and previews. */
export function routableProviders(providers: ProviderConfigItem[]): ProviderConfigItem[] {
  return providers.filter((p) => p.enabled !== false);
}

export interface ProviderListResponse {
  providers: ProviderConfigItem[];
}

export interface SessionInfo {
  id: string;
  providerId: string;
  profileId: string | null;
  proxyName: string | null;
  connectedAt: string;
  lastActivity: string;
  durationMs: number;
  messageCount: number;
}

export interface ParkedSessionInfo {
  sessionId: string;
  providerId: string;
  parkedAt: string;
  originalConnectedAt: string;
  messageCount: number;
  expiresAt: string;
}

export interface ParkedSessionsResponse {
  count: number;
  parked: ParkedSessionInfo[];
}

export interface GatewayStatus {
  status: string;
  activeSessions: number;
  queueSize: number;
  strategy: string;
  providers: ProviderStatus[];
}

export interface SessionsResponse {
  count: number;
  sessions: SessionInfo[];
}

export interface ProfileMetaItem {
  id: string;
  updatedAt: string;
  sizeBytes: number;
  dekVersion: number;
  /** Proxy sessions with this profile use when they name none. Absent on older gateways. */
  proxy?: string | null;
}

export interface ProfileListResponse {
  /** True when the profiles feature is enabled on the gateway. */
  enabled: boolean;
  count: number;
  profiles: ProfileMetaItem[];
  /** Present when enabled === false — human-readable instructions to enable. */
  reason?: string;
}

export async function fetchProfiles(): Promise<ProfileListResponse> {
  const res = await fetch(`${API_BASE}/v1/profiles`, fetchOpts);
  if (res.status === 401) throw new AuthError();
  if (res.status === 404) return { enabled: false, count: 0, profiles: [] };
  if (!res.ok) throw new Error(`Profiles API error: ${res.status}`);
  const body = (await res.json()) as ProfileListResponse;
  // Backwards-compat: gateways that pre-date the enabled flag don't include it.
  return { enabled: body.enabled ?? true, count: body.count, profiles: body.profiles, reason: body.reason };
}

export async function deleteProfile(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/profiles/${encodeURIComponent(id)}`, {
    method: "DELETE",
    ...fetchOpts,
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Delete failed: ${res.status}`);
  }
}

export function exportProfileUrl(id: string, format: "bgp" | "playwright" = "bgp"): string {
  const suffix = format === "playwright" ? "?format=playwright" : "";
  return `${API_BASE}/v1/profiles/${encodeURIComponent(id)}/export${suffix}`;
}

export async function importProfile(blob: Blob): Promise<{ imported: string; bytes: number }> {
  const res = await fetch(`${API_BASE}/v1/profiles/import`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: blob,
    ...fetchOpts,
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Import failed: ${res.status}`);
  }
  return res.json();
}

export async function importProfilePlaywright(
  id: string,
  storageState: unknown,
): Promise<{ imported: string; bytes: number; format: "playwright" }> {
  const res = await fetch(
    `${API_BASE}/v1/profiles/import?format=playwright&id=${encodeURIComponent(id)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(storageState),
      ...fetchOpts,
    },
  );
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Import failed: ${res.status}`);
  }
  return res.json();
}

export interface EnableProfilesResult {
  envPath: string;
  envWritten: boolean;
  envAlreadyHadKey: boolean;
  configPath: string;
  configWritten: boolean;
  configAlreadyHadBlock: boolean;
  restartRequired: boolean;
}

export async function setProfileProxy(id: string, proxy: string | null): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/profiles/${encodeURIComponent(id)}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proxy }),
    ...fetchOpts,
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Save failed: ${res.status}`);
  }
}

export async function createProfile(id: string, proxy: string | null = null): Promise<ProfileMetaItem> {
  const res = await fetch(`${API_BASE}/v1/profiles/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, proxy }),
    ...fetchOpts,
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Create failed: ${res.status}`);
  }
  return res.json();
}

export async function enableProfilesSetup(encryptionKey: string): Promise<EnableProfilesResult> {
  const res = await fetch(`${API_BASE}/v1/profiles/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encryptionKey }),
    ...fetchOpts,
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Setup failed: ${res.status}`);
  }
  return res.json();
}

export interface ToggleResult {
  configWritten: boolean;
  restartRequired: boolean;
}

async function postAction<T>(path: string, fallbackLabel: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: "POST", ...fetchOpts });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `${fallbackLabel}: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function disableProfiles(): Promise<ToggleResult> {
  return postAction<ToggleResult>("/v1/profiles/disable", "Disable failed");
}
