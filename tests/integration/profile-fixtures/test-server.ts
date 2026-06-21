import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

/**
 * Tiny HTTP test target for profile capture/inject tests.
 * - GET / → HTML page that runs no JS by default
 * - GET /login?u=NAME → sets a session cookie + a localStorage value via a header + tiny script
 * - GET /whoami → returns the current "session" cookie value as JSON
 */
export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      res.statusCode = 500;
      res.end(`server error: ${e instanceof Error ? e.message : String(e)}`);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = parsed.pathname;

  if (path === "/login") {
    const u = parsed.searchParams.get("u") ?? "anon";
    // Persistent cookie 1 year out
    const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
    res.setHeader("Set-Cookie", [
      `session=${encodeURIComponent(u)}; Path=/; Expires=${expires}; HttpOnly; SameSite=Lax`,
      `display=${encodeURIComponent(u)}; Path=/; Expires=${expires}; SameSite=Lax`,
    ]);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><title>login</title></head><body>
<script>
  localStorage.setItem("token", "tok-" + ${JSON.stringify(u)});
  localStorage.setItem("display", ${JSON.stringify(u)});
  sessionStorage.setItem("nonce", "n-" + ${JSON.stringify(u)});
</script>
<p>logged in as <strong id="me">${u}</strong></p>
</body></html>`);
    return;
  }

  if (path === "/whoami") {
    const cookieHeader = req.headers.cookie ?? "";
    const session = parseCookie(cookieHeader, "session");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ session }));
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><title>test</title></head><body>
<p>test page</p>
</body></html>`);
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v ?? "");
  }
  return null;
}
