import type { IncomingMessage } from "node:http";

/**
 * Return the effective protocol the client used to reach us, honoring
 * `X-Forwarded-Proto` set by a trusted reverse proxy. Falls back to the
 * request URL scheme.
 */
export function getEffectiveProtocol(c: { req: { header: (name: string) => string | undefined; url: string } }): "http" | "https" {
  const fwd = c.req.header("x-forwarded-proto");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim().toLowerCase();
    if (first === "https") return "https";
    if (first === "http") return "http";
  }
  if (c.req.url.startsWith("https://")) return "https";
  return "http";
}

/** Same as `getEffectiveProtocol` but operates on a raw Node `IncomingMessage`. */
export function getEffectiveProtocolNode(req: IncomingMessage): "http" | "https" {
  const fwd = req.headers["x-forwarded-proto"];
  const value = Array.isArray(fwd) ? fwd[0] : fwd;
  if (value) {
    const first = value.split(",")[0]?.trim().toLowerCase();
    if (first === "https") return "https";
    if (first === "http") return "http";
  }
  return "http";
}

/**
 * Return the effective host the client used to reach us, honoring
 * `X-Forwarded-Host` set by trusted reverse proxies. Falls back to the
 * `Host` header.
 */
export function getEffectiveHost(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "localhost:9500";
}

/**
 * Parse `BG_ALLOWED_ORIGINS` (comma-separated). Empty / unset returns
 * an empty set, which the gateway treats as "same-origin only".
 */
export function parseAllowedOrigins(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((o) => o.trim().replace(/\/$/, "").toLowerCase())
      .filter((o) => o.length > 0),
  );
}
