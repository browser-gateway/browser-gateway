import { CallbackTransport } from "../../core/cdp/callback-transport.js";

/** CDP over the runtime's built-in WebSocket (Node 22+, Deno, Bun, Workers, browsers). */
export class WebSocketTransport extends CallbackTransport {
  private readonly ws: WebSocket;

  constructor(url: string) {
    super();
    if (typeof WebSocket !== "function") {
      throw new Error("this runtime has no built-in WebSocket; pass a transport instead of an endpoint");
    }
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.emitMessage(event.data);
    });
    this.ws.addEventListener("close", (event) => this.emitClose(event.reason || `closed ${event.code}`));
  }

  ready(timeoutMs = 30_000): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`browser connection timed out after ${timeoutMs}ms`)), timeoutMs);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("could not connect to the browser endpoint"));
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
