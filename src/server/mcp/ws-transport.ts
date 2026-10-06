import WebSocket from "ws";
import { CallbackTransport } from "../../core/cdp/callback-transport.js";

/** Node WebSocket transport for the isomorphic CDP client. */
export class NodeCdpTransport extends CallbackTransport {
  private readonly ws: WebSocket;

  constructor(url: string, headers?: Record<string, string>) {
    super();
    this.ws = new WebSocket(url, { headers, handshakeTimeout: 30_000, perMessageDeflate: false });
    this.ws.on("message", (raw) => this.emitMessage(String(raw)));
    this.ws.on("close", (code, reason) => this.emitClose(String(reason) || `closed ${code}`));
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

  protected closeSocket(): void {
    this.ws.close();
  }
}
