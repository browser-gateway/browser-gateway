import type { CdpCookie } from "./cdp.js";
import { WsCDPClient } from "./cdp-client.js";

interface GetCookiesResponse {
  cookies: CdpCookie[];
}

/**
 * Capture all browser-level cookies via a transient CDP WebSocket.
 *
 * Opens a CDP WebSocket, runs Storage.getCookies (browser-wide, no target attach needed),
 * closes the connection. Total round trips: 1 + open + close.
 *
 * On providers that count each WebSocket as a billable concurrent session (Browserless),
 * this counts as one brief connection. On persistent-session providers (Steel,
 * Browserbase, our runtime, raw Chrome), this is essentially free.
 */
export async function captureCookiesViaTransient(
  wsUrl: string,
  timeoutMs = 10_000,
): Promise<CdpCookie[]> {
  const client = new WsCDPClient();
  await client.connect(wsUrl, timeoutMs);
  try {
    const res = (await client.send("Storage.getCookies")) as GetCookiesResponse | null;
    return res?.cookies ?? [];
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Inject cookies via a transient CDP WebSocket using Storage.setCookies.
 *
 * No-op if cookies is empty.
 */
export async function injectCookiesViaTransient(
  wsUrl: string,
  cookies: CdpCookie[],
  timeoutMs = 10_000,
): Promise<void> {
  if (cookies.length === 0) return;
  const client = new WsCDPClient();
  await client.connect(wsUrl, timeoutMs);
  try {
    await client.send("Storage.setCookies", {
      cookies: cookies.map(prepareCookieForInject),
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Strip fields the CDP setCookies API doesn't accept on injection. The shape returned
 * by getCookies has metadata (size, session) that's not valid input.
 */
function prepareCookieForInject(c: CdpCookie): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
  };
  if (c.expires !== undefined && c.expires > 0) out.expires = c.expires;
  if (c.sameSite) out.sameSite = c.sameSite;
  if (c.priority) out.priority = c.priority;
  if (c.sourceScheme && c.sourceScheme !== "Unset") out.sourceScheme = c.sourceScheme;
  if (c.sourcePort && c.sourcePort > 0) out.sourcePort = c.sourcePort;
  if (c.sameParty !== undefined) out.sameParty = c.sameParty;
  if (c.partitionKey !== undefined) out.partitionKey = c.partitionKey;
  return out;
}
