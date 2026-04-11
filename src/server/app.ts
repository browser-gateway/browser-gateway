import { Hono } from "hono";
import { cors } from "hono/cors";
import { timingSafeEqual, createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import WebSocket from "ws";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import type { Gateway } from "../core/index.js";
import { isHttpUrl, fetchCdpVersion } from "../core/providers/cdp.js";
import { ProviderConfigSchema } from "../core/types.js";
import { writeConfig } from "./config/writer.js";
import { loadedConfigPath } from "./config/loader.js";
import type { SessionPool } from "../core/pool/index.js";
import { createRestRoutes } from "./rest/index.js";

function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf-8"));
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

function safeTokenCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const COOKIE_NAME = "bg_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days in seconds

function getSessionSecret(token?: string): string {
  if (token) {
    return createHmac("sha256", "bg-session-secret").update(token).digest("hex");
  }
  return randomBytes(32).toString("hex");
}

function signSession(secret: string): string {
  const payload = Buffer.from(JSON.stringify({ a: true, t: Date.now() })).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(cookie: string, secret: string): boolean {
  const [payload, sig] = cookie.split(".");
  if (!payload || !sig) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function getCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1];
}

function isAuthenticated(c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }, token: string, sessionSecret: string): boolean {
  const cookie = getCookie(c.req.header("cookie"), COOKIE_NAME);
  if (cookie && verifySession(cookie, sessionSecret)) return true;

  const reqToken =
    c.req.query("token") ??
    (c.req.header("authorization")?.startsWith("Bearer ")
      ? c.req.header("authorization")!.slice(7)
      : undefined);

  if (reqToken && safeTokenCompare(reqToken, token)) return true;

  return false;
}

export function createApp(gateway: Gateway, token?: string, webDir?: string, logger?: Logger, pool?: SessionPool) {
  const app = new Hono();
  const sessionSecret = getSessionSecret(token);

  if (process.env.NODE_ENV !== "production") {
    app.use("*", cors({ origin: "*", credentials: true }));
  }

  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/json/version", (c) => {
    const host = c.req.header("host") ?? "localhost:9500";
    const protocol = c.req.url.startsWith("https") ? "wss" : "ws";
    const tokenParam = c.req.query("token");
    const wsUrl = `${protocol}://${host}/v1/connect${tokenParam ? `?token=${tokenParam}` : ""}`;

    return c.json({
      Browser: `browser-gateway/${getPackageVersion()}`,
      "Protocol-Version": "1.3",
      webSocketDebuggerUrl: wsUrl,
    });
  });

  app.get("/json/version/", (c) => {
    return c.redirect("/json/version");
  });

  app.use("/v1/*", async (c, next) => {
    if (!token) return next();
    if (isAuthenticated(c, token, sessionSecret)) return next();
    return c.json({ error: "Unauthorized" }, 401);
  });

  app.get("/v1/status", (c) => {
    const status = gateway.getStatus();

    const providers = status.providers.map((b) => ({
      id: b.id,
      healthy: b.healthy,
      active: b.active,
      maxConcurrent: b.config.limits?.maxConcurrent ?? null,
      cooldownUntil: b.cooldownUntil
        ? new Date(b.cooldownUntil).toISOString()
        : null,
      avgLatencyMs: Math.round(b.avgLatencyMs),
      totalConnections: b.totalConnections,
      priority: b.config.priority,
    }));

    return c.json({
      status: status.shuttingDown ? "shutting_down" : "ok",
      activeSessions: status.activeSessions,
      queueSize: status.queueSize,
      strategy: status.strategy,
      providers,
      ...(pool ? { pool: pool.getStatus() } : {}),
    });
  });

  app.get("/v1/sessions", (c) => {
    const sessions = gateway.sessions.getAll().map((s) => ({
      id: s.id,
      providerId: s.providerId,
      connectedAt: new Date(s.connectedAt).toISOString(),
      lastActivity: new Date(s.lastActivity).toISOString(),
      durationMs: Date.now() - s.connectedAt,
      messageCount: s.messageCount,
    }));

    return c.json({
      count: sessions.length,
      sessions,
    });
  });

  if (pool) {
    const restLogger = logger ?? gateway.logger;
    const restRoutes = createRestRoutes(pool, gateway, restLogger);
    app.route("/v1", restRoutes);
  }

  // Provider CRUD endpoints
  app.get("/v1/providers", (c) => {
    const providers = Object.entries(gateway.config.providers).map(([id, p]) => ({
      id,
      url: p.url.replace(/([?&])(token|apiKey|key|secret|password)=[^&]*/gi, "$1$2=***"),
      maxConcurrent: p.limits?.maxConcurrent ?? null,
      priority: p.priority,
      weight: p.weight ?? 1,
    }));
    return c.json({ providers });
  });

  app.post("/v1/providers", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const id = body.id as string | undefined;
    const url = body.url as string | undefined;
    const maxConcurrent = body.maxConcurrent as number | undefined;
    const priority = body.priority as number | undefined;
    const weight = body.weight as number | undefined;

    if (!id || !url) {
      return c.json({ error: "Missing required fields: id, url" }, 400);
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return c.json({ error: "Provider ID must be alphanumeric with hyphens/underscores only" }, 400);
    }

    if (gateway.config.providers[id]) {
      return c.json({ error: `Provider '${id}' already exists` }, 409);
    }

    const providerConfig = ProviderConfigSchema.safeParse({
      url,
      limits: maxConcurrent ? { maxConcurrent } : undefined,
      priority: priority ?? 1,
      weight: weight ?? 1,
    });

    if (!providerConfig.success) {
      const errors = providerConfig.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      return c.json({ error: "Invalid provider config", details: errors }, 400);
    }

    gateway.config.providers[id] = providerConfig.data;
    gateway.registry.register(id, providerConfig.data);

    try {
      writeConfig(gateway.config);
    } catch (err) {
      return c.json({ error: "Provider added but failed to save config file" }, 500);
    }

    return c.json({ ok: true, id }, 201);
  });

  app.put("/v1/providers/:id", async (c) => {
    const id = c.req.param("id");
    if (!gateway.config.providers[id]) {
      return c.json({ error: `Provider '${id}' not found` }, 404);
    }

    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const url = body.url as string | undefined;
    const maxConcurrent = body.maxConcurrent as number | undefined;
    const priority = body.priority as number | undefined;
    const weight = body.weight as number | undefined;

    const existing = gateway.config.providers[id];
    const providerConfig = ProviderConfigSchema.safeParse({
      url: url ?? existing.url,
      limits: maxConcurrent !== undefined ? { maxConcurrent } : existing.limits,
      priority: priority ?? existing.priority,
      weight: weight ?? existing.weight ?? 1,
    });

    if (!providerConfig.success) {
      const errors = providerConfig.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      return c.json({ error: "Invalid provider config", details: errors }, 400);
    }

    gateway.config.providers[id] = providerConfig.data;

    const state = gateway.registry.get(id);
    if (state) {
      state.config = providerConfig.data;
    }

    try {
      writeConfig(gateway.config);
    } catch {
      return c.json({ error: "Provider updated but failed to save config file" }, 500);
    }

    return c.json({ ok: true, id });
  });

  app.delete("/v1/providers/:id", (c) => {
    const id = c.req.param("id");
    if (!gateway.config.providers[id]) {
      return c.json({ error: `Provider '${id}' not found` }, 404);
    }

    const state = gateway.registry.get(id);
    if (state && state.active > 0) {
      return c.json({ error: `Provider '${id}' has ${state.active} active connections. Disconnect them first.` }, 409);
    }

    delete gateway.config.providers[id];
    gateway.registry.remove(id);

    try {
      writeConfig(gateway.config);
    } catch {
      return c.json({ error: "Provider removed but failed to save config file" }, 500);
    }

    return c.json({ ok: true, id });
  });

  app.post("/v1/providers/:id/test", async (c) => {
    const id = c.req.param("id");
    const provider = gateway.config.providers[id];

    let url: string;
    if (provider) {
      url = provider.url;
    } else {
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      url = body.url as string;
      if (!url) return c.json({ error: "Provider not found and no URL provided" }, 400);
    }

    const start = Date.now();
    try {
      if (isHttpUrl(url)) {
        const data = await fetchCdpVersion(url, 5000);
        return c.json({
          ok: true,
          latencyMs: Date.now() - start,
          browser: data.browser,
          wsUrl: data.webSocketDebuggerUrl,
        });
      }

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url, { handshakeTimeout: 5000 });
        ws.on("open", () => { ws.close(); resolve(); });
        ws.on("error", reject);
        setTimeout(() => { ws.close(); reject(new Error("timeout")); }, 5000);
      });
      return c.json({ ok: true, latencyMs: Date.now() - start });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message, latencyMs: Date.now() - start });
    }
  });

  // Config editor endpoints
  app.get("/v1/config", (c) => {
    const path = loadedConfigPath;
    if (!path || !existsSync(path)) {
      return c.json({ yaml: "", path: null, exists: false });
    }
    const yaml = readFileSync(path, "utf-8");
    return c.json({ yaml, path, exists: true });
  });

  app.post("/v1/config/validate", async (c) => {
    const { parse } = await import("yaml");
    const { GatewayConfigSchema } = await import("../core/types.js");

    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const yaml = body.yaml as string | undefined;
    if (!yaml) return c.json({ valid: false, errors: ["No YAML content provided"] });

    try {
      const parsed = parse(yaml) as Record<string, unknown>;
      const result = GatewayConfigSchema.safeParse(parsed);
      if (result.success) {
        const providerCount = Object.keys(result.data.providers).length;
        return c.json({ valid: true, providerCount });
      }
      const errors = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      return c.json({ valid: false, errors });
    } catch (err: any) {
      return c.json({ valid: false, errors: [`YAML parse error: ${err.message}`] });
    }
  });

  app.put("/v1/config", async (c) => {
    const { parse } = await import("yaml");
    const { GatewayConfigSchema } = await import("../core/types.js");

    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const yaml = body.yaml as string | undefined;
    if (!yaml) return c.json({ error: "No YAML content provided" }, 400);

    try {
      const parsed = parse(yaml) as Record<string, unknown>;
      const result = GatewayConfigSchema.safeParse(parsed);
      if (!result.success) {
        const errors = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
        return c.json({ error: "Invalid configuration", details: errors }, 400);
      }
    } catch (err: any) {
      return c.json({ error: `YAML parse error: ${err.message}` }, 400);
    }

    const path = loadedConfigPath ?? "./gateway.yml";
    if (existsSync(path)) {
      copyFileSync(path, `${path}.backup`);
    }
    writeFileSync(path, yaml, "utf-8");

    return c.json({ ok: true, message: "Config saved. Restart the gateway to apply changes." });
  });

  if (webDir && existsSync(webDir)) {
    app.post("/web/auth", async (c) => {
      if (!token) {
        return c.json({ error: "Auth not configured" }, 400);
      }

      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      const submitted = body.token as string | undefined;

      if (!submitted || !safeTokenCompare(submitted, token)) {
        return c.json({ error: "Invalid token" }, 401);
      }

      const sessionValue = signSession(sessionSecret);
      const isSecure = c.req.header("x-forwarded-proto") === "https" || c.req.url.startsWith("https");
      const cookieParts = [
        `${COOKIE_NAME}=${sessionValue}`,
        `Path=/`,
        `HttpOnly`,
        `SameSite=Strict`,
        `Max-Age=${SESSION_MAX_AGE}`,
      ];
      if (isSecure) cookieParts.push("Secure");

      c.header("Set-Cookie", cookieParts.join("; "));
      return c.json({ ok: true });
    });

    app.post("/web/logout", (c) => {
      c.header("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      return c.json({ ok: true });
    });

    app.get("/web/auth/check", (c) => {
      if (!token) return c.json({ authenticated: true, authRequired: false });

      const cookie = getCookie(c.req.header("cookie"), COOKIE_NAME);
      const authenticated = cookie ? verifySession(cookie, sessionSecret) : false;
      return c.json({ authenticated, authRequired: true });
    });

    app.get("/web", (c) => c.redirect("/web/"));

    app.get("/web/*", (c) => {
      const urlPath = new URL(c.req.url).pathname.replace(/^\/web/, "") || "/";

      const tryPaths = [
        join(webDir, urlPath),
        join(webDir, urlPath, "index.html"),
        join(webDir, urlPath + ".html"),
      ];

      for (const filePath of tryPaths) {
        if (existsSync(filePath) && !filePath.endsWith("/")) {
          try {
            const content = readFileSync(filePath);
            const ext = extname(filePath);
            const contentType = MIME_TYPES[ext] || "application/octet-stream";
            return c.body(content, 200, { "Content-Type": contentType });
          } catch {
            continue;
          }
        }
      }

      const indexPath = join(webDir, "index.html");
      if (existsSync(indexPath)) {
        const content = readFileSync(indexPath);
        return c.body(content, 200, { "Content-Type": "text/html" });
      }

      return c.json({ error: "Not found" }, 404);
    });
  }

  app.notFound((c) => {
    return c.json(
      {
        error: "Not found",
        message: "WebSocket at /v1/connect, REST API at /v1/screenshot or /v1/content or /v1/scrape, dashboard at /web, status at /v1/status",
      },
      404
    );
  });

  return app;
}
