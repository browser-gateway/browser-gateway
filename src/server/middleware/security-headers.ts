import type { MiddlewareHandler } from "hono";
import { getEffectiveProtocol } from "../util/request.js";

/**
 * Production security headers — HSTS, nosniff, frame-ancestors, Referrer-Policy.
 * Applied to every HTTP response. Cheap defenses against MITM downgrade,
 * MIME-sniffing, clickjacking, and Referer-based token leakage.
 *
 * HSTS is only emitted when the request itself was over HTTPS — emitting
 * over plain HTTP is a no-op per the spec and risks a misconfigured client
 * locking onto an HTTP-only loopback.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (getEffectiveProtocol(c) === "https") {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
  };
}
