import type { CdpCookie } from "./cdp.js";
import { WsCDPClient } from "./cdp-client.js";

interface GetCookiesResponse {
  cookies: CdpCookie[];
}

/**
 * Wrap an op so it rejects after timeoutMs even when the underlying Promise has
 * no internal timer. Critical for CDP send(): the WS may stay open while the
 * peer never responds. Combined with closing the client on timeout (H2 fix),
 * this guarantees the lifecycle never holds a lock indefinitely.
 */
function withDeadline<T>(op: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
    op.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Capture all browser-level cookies via a transient CDP WebSocket.
 *
 * timeoutMs covers the entire operation (connect + send + close). If the peer
 * never responds, the deadline fires, the client is closed (rejecting any
 * pending send via the H2 fix), and the lifecycle's lock is released.
 *
 * On providers that count each WebSocket as a billable concurrent session
 * (Browserless), this counts as one brief connection. On persistent-session
 * providers (Steel, Browserbase, our runtime, raw Chrome), this is essentially free.
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
          cookies: cookies.map(prepareCookieForInject),
        });
      })(),
      timeoutMs,
      "injectCookiesViaTransient",
    );
  } finally {
    await client.close().catch(() => undefined);
  }
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
