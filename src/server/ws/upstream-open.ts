import { WebSocket } from "ws";

/** Open a Node `ws` upstream and race it against a timeout. Resolves once
 *  `open` fires; rejects (via `{ok:false, err}`) on `error` or timeout. */
export function openUpstream(
  url: string,
  timeoutMs: number,
): Promise<{ ok: true; ws: WebSocket } | { ok: false; err: string }> {
  const ws = new WebSocket(url, {
    handshakeTimeout: timeoutMs,
    perMessageDeflate: false,
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
