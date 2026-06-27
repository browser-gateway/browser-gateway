import type { MiddlewareHandler } from "hono";
import { getEffectiveProtocol } from "../util/request.js";

/**
 * Paths whose response is consumed by infrastructure probes (Railway,
 * Kubernetes, Docker HEALTHCHECK) rather than browsers. Some PaaS edges
 * fail their internal probe when extra response headers (`CSP`,
 * `X-Frame-Options`) are present, so we skip the security layer for these
 * routes. No XSS / clickjacking surface lives at these endpoints.
 */
const HEADER_SKIP_PATHS = new Set(["/health"]);

/**
 * Production security headers — HSTS, nosniff, frame-ancestors, Referrer-Policy.
 * Applied to every HTTP response except infrastructure-probe paths.
 *
 * HSTS is only emitted when the request itself was over HTTPS — emitting
 * over plain HTTP is a no-op per the spec and risks a misconfigured client
 * locking onto an HTTP-only loopback.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (HEADER_SKIP_PATHS.has(c.req.path)) return;
    if (getEffectiveProtocol(c) === "https") {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
  };
}
