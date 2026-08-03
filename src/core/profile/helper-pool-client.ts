/** CDP client shape the profile helper-pool depends on. Any client that can
 *  send commands (with or without a flat-mode sessionId) and register raw
 *  CDP event listeners satisfies this. `WsCDPClient` implements it
 *  natively; `PluginCdpClient` implements it via a `SessionState`. */
export interface HelperPoolCdpClient {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  sendOn<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  on(method: string, handler: (params: unknown) => void): void;
  off(method: string, handler: (params: unknown) => void): void;
}
