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
  data: { url?: string; maxConcurrent?: number; priority?: number }
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
  strategy: string;
  providers: ProviderStatus[];
}

export interface SessionsResponse {
  count: number;
  sessions: SessionInfo[];
}
