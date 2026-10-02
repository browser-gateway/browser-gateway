import type { CdpMessage, CdpPlugin, SessionState } from "../types.js";

/** Turns a client's `Browser.close` into an orderly disconnect: the client
 *  gets its reply, then the session ends with the browser still running, so
 *  a provider that saves state when the connection closes still saves it. */
export class BrowserCloseAsDisconnectPlugin implements CdpPlugin {
  readonly name = "browser-close-as-disconnect";

  private readonly pendingIds = new Set<number>();

  onCommand(msg: CdpMessage): CdpMessage | undefined {
    if (msg.method !== "Browser.close" || msg.sessionId || typeof msg.id !== "number") return undefined;
    this.pendingIds.add(msg.id);
    return { id: msg.id, method: "Browser.getVersion" };
  }

  onResponse(msg: CdpMessage, state: SessionState): void {
    if (typeof msg.id !== "number" || !this.pendingIds.delete(msg.id)) return;
    state.close("client-closed-browser");
  }
}
