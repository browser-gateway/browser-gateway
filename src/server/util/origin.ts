import type { IncomingMessage } from "node:http";
import { getEffectiveProtocolNode } from "./request.js";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** Reads the request's own `Host`. `X-Forwarded-Host` is client-supplied unless
 *  a proxy overwrites it, so it is consulted only when `BG_TRUST_PROXY` is set. */
function requestHost(req: IncomingMessage): string | undefined {
  const forwarded = process.env.BG_TRUST_PROXY === "1" ? req.headers["x-forwarded-host"] : undefined;
  const raw = forwarded ?? req.headers.host;
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Browser-CSRF guard. Rejects a request carrying a foreign browser `Origin`.
 *
 * CDP / Playwright / MCP clients do not send `Origin` (they are non-browser
 * sockets), so an absent header is allowed and that path stays auth-only. When
 * `Origin` is present it must match the request's own host or appear in the
 * `BG_ALLOWED_ORIGINS` allowlist.
 */
export function isOriginAllowed(req: IncomingMessage, allowedOrigins: Set<string>): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const normalized = origin.replace(/\/$/, "").toLowerCase();
  if (allowedOrigins.has(normalized)) return true;
  try {
    const u = new URL(origin);
    const reqHostStr = requestHost(req);
    if (reqHostStr && u.host.toLowerCase() === reqHostStr.toLowerCase()) {
      const expected = getEffectiveProtocolNode(req) === "https" ? "https:" : "http:";
      return u.protocol === expected;
    }
  } catch {
    // fall through
  }
  return false;
}

/**
 * DNS-rebinding guard. A rebound name resolves to loopback but keeps the
 * attacker's hostname in `Host`, so a loopback-only listener is not enough.
 * Accepts loopback hostnames plus anything in `BG_ALLOWED_HOSTS`.
 */
export function isHostAllowed(req: IncomingMessage, allowedHosts: Set<string>): boolean {
  const value = requestHost(req);
  if (!value) return false;
  const hostname = value.toLowerCase().replace(/:\d+$/, "");
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  return allowedHosts.has(hostname) || allowedHosts.has(value.toLowerCase());
}

/** Parse `BG_ALLOWED_HOSTS` (comma-separated hostnames). */
export function parseAllowedHosts(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0),
  );
}
