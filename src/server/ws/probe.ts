import WebSocket from "ws";

/**
 * Probe a WebSocket URL: resolves on `open` (then immediately closes), rejects
 * on `error` or timeout. Used by `POST /v1/providers/:id/test` and the CLI
 * `browser-gateway check` to verify reachability of a provider WS endpoint.
 */
export function probeWebSocket(url: string, timeoutMs = 5_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("timeout"));
    }, timeoutMs);
    ws.on("open", () => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve();
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
