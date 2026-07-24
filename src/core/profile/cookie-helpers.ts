import type { CdpCookie } from "./cdp.js";
import { WsCDPClient } from "./cdp-client.js";
import { withDeadline } from "./helper-pool.js";

interface GetCookiesResponse {
  cookies: CdpCookie[];
}

/**
 * Capture all browser-level cookies via a transient CDP WebSocket.
 *
 * timeoutMs covers the entire operation (connect + send + close). If the peer
 * never responds, the deadline fires, the client is closed (rejecting any
 * pending send via the H2 fix), and the lifecycle's lock is released.
 *
 * On providers that count each WebSocket as a billable concurrent session,
 * this counts as one brief connection. On persistent-session providers and
 * raw Chrome, this is essentially free.
 */
export async function captureCookiesViaTransient(
  wsUrl: string,
  timeoutMs = 10_000,
): Promise<CdpCookie[]> {
  const client = new WsCDPClient();
  try {
    return await withDeadline(
      (async () => {
        await client.connect(wsUrl, timeoutMs);
        const res = (await client.send("Storage.getCookies")) as GetCookiesResponse | null;
        return res?.cookies ?? [];
      })(),
      timeoutMs,
      "captureCookiesViaTransient",
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Inject cookies via a transient CDP WebSocket using Storage.setCookies.
 *
 * No-op if cookies is empty. timeoutMs covers the entire operation.
 */
export async function injectCookiesViaTransient(
  wsUrl: string,
  cookies: CdpCookie[],
  timeoutMs = 10_000,
): Promise<void> {
  if (cookies.length === 0) return;
  const client = new WsCDPClient();
  try {
    await withDeadline(
      (async () => {
        await client.connect(wsUrl, timeoutMs);
        await client.send("Storage.setCookies", {
          cookies: sanitizeCookiesForInject(cookies),
        });
      })(),
      timeoutMs,
      "injectCookiesViaTransient",
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Approximate per-cookie byte ceiling (name + value); Chrome rejects around 4 KB. */
const MAX_COOKIE_BYTES = 4096;

/**
 * Whether a captured cookie can be faithfully and safely re-injected.
 *
 * Returns false only for cookies Chrome would itself reject or evict, or that
 * cannot be reproduced without weakening their scope. Never mutates a cookie to
 * make it "fit" — a security attribute is preserved or the cookie is dropped.
 * Rejects: `SameSite=None` without `secure` (Chrome excludes it); a persistent
 * cookie already past `expires`; an opaque partition key (not serializable —
 * re-injecting unpartitioned would broaden scope); a `__Host-`/`__Secure-`
 * cookie violating its prefix rules (would fail the whole setCookies batch);
 * an oversized cookie.
 */
export function isInjectableCookie(c: CdpCookie, nowSecs: number = Date.now() / 1000): boolean {
  if (c.sameSite === "None" && !c.secure) return false;
  if (c.expires !== undefined && c.expires > 0 && c.expires < nowSecs) return false;
  if (c.partitionKeyOpaque === true) return false;
  if (c.name.startsWith("__Host-")) {
    if (!c.secure || c.path !== "/" || c.domain.startsWith(".")) return false;
  } else if (c.name.startsWith("__Secure-")) {
    if (!c.secure) return false;
  }
  if (c.name.length + c.value.length > MAX_COOKIE_BYTES) return false;
  return true;
}

/**
 * Filter a captured cookie jar to the safely-injectable subset, then map each
 * survivor to setCookies input. Every inject path uses this so one malformed or
 * un-restorable cookie can't downgrade another or fail the whole batch.
 */
export function sanitizeCookiesForInject(
  cookies: CdpCookie[],
  nowSecs: number = Date.now() / 1000,
): Record<string, unknown>[] {
  return cookies.filter((c) => isInjectableCookie(c, nowSecs)).map(prepareCookieForInject);
}

/**
 * Strip fields the CDP setCookies API doesn't accept on injection. The shape returned
 * by getCookies has metadata (size, session) that's not valid input.
 *
 * Exported so callers building their own setCookies batch (e.g. the per-origin
 * inject path in `inject.ts`) don't reimplement the same field-filtering logic.
 */
export function prepareCookieForInject(c: CdpCookie): Record<string, unknown> {
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
