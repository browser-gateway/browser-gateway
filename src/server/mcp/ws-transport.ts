import WebSocket from "ws";
import type { CdpTransport } from "../../core/cdp/protocol.js";

/** Node WebSocket transport for the isomorphic CDP client. */
export class NodeCdpTransport implements CdpTransport {
  private readonly ws: WebSocket;
  private messageHandler: ((data: string) => void) | null = null;
  private closeHandler: ((reason?: string) => void) | null = null;

  constructor(url: string, headers?: Record<string, string>) {
    this.ws = new WebSocket(url, { headers, handshakeTimeout: 30_000, perMessageDeflate: false });
    this.ws.on("message", (raw) => this.messageHandler?.(String(raw)));
    this.ws.on("close", (code, reason) => this.closeHandler?.(String(reason) || `closed ${code}`));
  }

  ready(timeoutMs = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timed out after ${timeoutMs}ms`)), timeoutMs);
      this.ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      this.ws.once("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        reject(new Error(`CDP upgrade rejected with HTTP ${res.statusCode}`));
      });
    });
  }

  send(data: string): void {
    this.ws.send(data);
  }

  onMessage(cb: (data: string) => void): void {
    this.messageHandler = cb;
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeHandler = cb;
  }

  async close(): Promise<void> {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}
