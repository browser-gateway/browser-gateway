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

export async function fetchProviders(): Promise<ProviderListResponse> {
  const res = await fetch(`${API_BASE}/v1/providers`, fetchOpts);
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Providers API error: ${res.status}`);
  return res.json();
}

export async function addProvider(data: {
  id: string;
  url: string;
  maxConcurrent?: number;
  priority?: number;
  weight?: number;
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
  data: { url?: string; maxConcurrent?: number; priority?: number; weight?: number }
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

export async function testProvider(
  id: string,
  url?: string
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const res = await fetch(`${API_BASE}/v1/providers/${id}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(url ? { url } : {}),
    credentials: "include",
  });
  return res.json();
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
  cooldownUntil: string | null;
  avgLatencyMs: number;
  totalConnections: number;
  priority: number;
}

export interface ProviderConfigItem {
  id: string;
  url: string;
  maxConcurrent: number | null;
  priority: number;
  weight: number;
}

export interface ProviderListResponse {
  providers: ProviderConfigItem[];
}

export interface SessionInfo {
  id: string;
  providerId: string;
  connectedAt: string;
  lastActivity: string;
  durationMs: number;
  messageCount: number;
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

export function exportProfileUrl(id: string): string {
  return `${API_BASE}/v1/profiles/${encodeURIComponent(id)}/export`;
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

export interface EnableProfilesResult {
  envPath: string;
  envWritten: boolean;
  envAlreadyHadKey: boolean;
  configPath: string;
  configWritten: boolean;
  configAlreadyHadBlock: boolean;
  restartRequired: boolean;
}

export async function createProfile(id: string): Promise<ProfileMetaItem> {
  const res = await fetch(`${API_BASE}/v1/profiles/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
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
