import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export interface BrowserserveDropOffState {
  latestPayload: BrowserservePayload | null;
  tokens: Map<string, BrowserservePayload | null>;
  dropOffCalls: number;
  pickUpCalls: number;
  reset(): void;
}

export interface BrowserservePayload {
  cookies: unknown[];
  localStorage: unknown[];
  indexeddb: unknown[];
}

/** Adds POST /v1/profile + GET /v1/profile/:token handlers to a running http.Server,
 *  making it satisfy the browserserve drop-off / pick-up contract used by the router
 *  when a provider is detected as browserserve. The captured cookie source of truth
 *  stays on the mock's existing CDP-layer state; `getCurrentPayload()` is called on
 *  pick-up so callers can reflect intra-session mutations back to the router. */
export function enableBrowserserveDropOff(
  server: Server,
  getCurrentPayload: () => BrowserservePayload,
): BrowserserveDropOffState {
  const state: BrowserserveDropOffState = {
    latestPayload: null,
    tokens: new Map(),
    dropOffCalls: 0,
    pickUpCalls: 0,
    reset() {
      state.latestPayload = null;
      state.tokens.clear();
      state.dropOffCalls = 0;
      state.pickUpCalls = 0;
    },
  };

  const originalListeners = server.listeners("request");
  server.removeAllListeners("request");

  server.on("request", async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/v1/profile") {
      state.dropOffCalls += 1;
      const body = await readBody(req);
      try {
        state.latestPayload = JSON.parse(body) as BrowserservePayload;
      } catch {
        state.latestPayload = null;
      }
      const token = randomUUID();
      state.tokens.set(token, state.latestPayload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ profileToken: token }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/v1/profile/")) {
      const token = req.url.slice("/v1/profile/".length);
      if (!state.tokens.has(token)) {
        res.writeHead(404).end();
        return;
      }
      state.pickUpCalls += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getCurrentPayload()));
      return;
    }
    for (const listener of originalListeners) {
      (listener as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
      if (res.writableEnded) return;
    }
  });

  return state;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
