import { WebSocket } from "ws";

/** Open a Node `ws` upstream and race it against a timeout. Resolves once
 *  `open` fires; rejects (via `{ok:false, err}`) on `error` or timeout.
 *  `headers` forwards provider-config and/or client-derived headers on the WS
 *  upgrade (Authorization: Bearer, X-API-Key, subprotocol negotiation, etc.). */
export function openUpstream(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<{ ok: true; ws: WebSocket } | { ok: false; err: string }> {
  const ws = new WebSocket(url, {
    handshakeTimeout: timeoutMs,
    perMessageDeflate: false,
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
  });
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { ws.close(); } catch { /* already closed */ }
      resolve({ ok: false, err: "upstream-timeout" });
    }, timeoutMs);
    ws.once("open", () => { clearTimeout(timeout); resolve({ ok: true, ws }); });
    ws.once("error", (err) => { clearTimeout(timeout); resolve({ ok: false, err: err.message }); });
  });
}
