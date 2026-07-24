import type { CdpCookie } from "../../core/profile/cdp.js";
import type { BrowserserveFile, OriginStorage } from "../../core/profile/types.js";
import type { AcquiredProfile } from "./lifecycle.js";

/** The profile shape browserserve's `/v1/profile` accepts and returns. */
export interface BrowserservePayload {
  cookies: CdpCookie[];
  localStorage: { origin: string; localStorage: { name: string; value: string }[] }[];
  indexeddb: BrowserserveFile[];
}

/** Derives the HTTP base and auth token from a provider `ws(s)://…?token=` URL. */
export function browserserveHttp(wsUrl: string): { base: string; authToken: string | null } {
  const url = new URL(wsUrl);
  const scheme = url.protocol === "wss:" ? "https:" : "http:";
  return { base: `${scheme}//${url.host}`, authToken: url.searchParams.get("token") };
}

/** Adds `?profileToken=` to a provider connect URL. */
export function withProfileToken(wsUrl: string, token: string): string {
  const url = new URL(wsUrl);
  url.searchParams.set("profileToken", token);
  return url.toString();
}

function authHeaders(authToken: string | null): Record<string, string> {
  return authToken ? { authorization: `Bearer ${authToken}` } : {};
}

/** Maps the gateway's acquired profile to browserserve's payload shape. */
export function toBrowserservePayload(acquired: AcquiredProfile): BrowserservePayload {
  const localStorage = Object.entries(acquired.storage).map(([origin, data]) => ({
    origin,
    localStorage: Object.entries(data.localStorage ?? {}).map(([name, value]) => ({ name, value })),
  }));
  return { cookies: acquired.cookies, localStorage, indexeddb: acquired.indexeddb ?? [] };
}

/** Maps a browserserve captured payload back to the gateway's stored shape. */
export function fromBrowserservePayload(payload: BrowserservePayload): {
  cookies: CdpCookie[];
  storage: Record<string, OriginStorage>;
  indexeddb: BrowserserveFile[];
} {
  const storage: Record<string, OriginStorage> = {};
  for (const origin of payload.localStorage ?? []) {
    const localStorage: Record<string, string> = {};
    for (const entry of origin.localStorage ?? []) localStorage[entry.name] = entry.value;
    storage[origin.origin] = { localStorage, sessionStorage: {} };
  }
  return { cookies: payload.cookies ?? [], storage, indexeddb: payload.indexeddb ?? [] };
}

/** Drops a profile at browserserve and returns its one-shot token. */
export async function dropOffProfile(
  base: string,
  authToken: string | null,
  payload: BrowserservePayload,
  timeoutMs = 15_000,
): Promise<string> {
  const res = await fetch(`${base}/v1/profile`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(authToken) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`browserserve drop-off ${res.status}`);
  return ((await res.json()) as { profileToken: string }).profileToken;
}

/**
 * Picks up the captured profile once the session ends, polling past 404 until
 * browserserve deposits it. Returns null if it never arrives in time (the
 * caller then preserves the previous profile).
 */
export async function pickUpProfile(
  base: string,
  authToken: string | null,
  token: string,
  timeoutMs = 20_000,
): Promise<BrowserservePayload | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/v1/profile/${token}`, {
      headers: authHeaders(authToken),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 200) return (await res.json()) as BrowserservePayload;
    if (res.status !== 404) throw new Error(`browserserve pick-up ${res.status}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
