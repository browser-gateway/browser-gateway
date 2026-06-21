/**
 * Minimal CDP client interface.
 *
 * We accept any object that can `send` CDP commands and is an EventEmitter for
 * CDP events. This matches puppeteer-core's `CDPSession` shape without coupling
 * us to puppeteer-core's specific types or library version.
 *
 * Tests pass a mock implementation; production passes a real CDPSession.
 */
export interface CDPClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (params: unknown) => void): this | unknown;
  off(event: string, listener: (params: unknown) => void): this | unknown;
}

/** A cookie as returned by Network.getAllCookies and accepted by Network.setCookies. */
export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  size?: number;
  httpOnly: boolean;
  secure: boolean;
  session?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  priority?: "Low" | "Medium" | "High";
  sameParty?: boolean;
  sourceScheme?: "Unset" | "NonSecure" | "Secure";
  sourcePort?: number;
  partitionKey?: unknown;
}

export interface GetAllCookiesResponse {
  cookies: CdpCookie[];
}

export interface RuntimeEvaluateResponse {
  result: {
    type: string;
    value?: unknown;
    description?: string;
  };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string };
  };
}
