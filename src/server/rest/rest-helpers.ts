/**
 * Server-side REST helpers. The Hono-tied bits live here; the pure content-
 * extraction helpers (Defuddle + linkedom) moved to
 * `src/rest-schemas/helpers.ts` so downstream isomorphic runtimes can reuse them.
 */
import type { Context } from "hono";
import type { PageOptions } from "./executor.js";

/**
 * Shape of the common base fields shared by every REST endpoint request body
 * (defined in `src/rest-schemas/index.ts` as `BaseFields`).
 *
 * Derived from {@link PageOptions} by stripping `signal` — the signal comes
 * from the Hono `Context`, not from the request body. Keeping these two types
 * tied via Omit ensures they stay in sync if PageOptions evolves.
 */
export type BaseRequestFields = Omit<PageOptions, "signal">;

/** Map a request body + Hono context to the executor's PageOptions shape. */
export function pageOptionsFromBody(body: BaseRequestFields, c: Context): PageOptions {
  return {
    url: body.url,
    viewport: body.viewport,
    waitUntil: body.waitUntil,
    waitForSelector: body.waitForSelector,
    waitForTimeout: body.waitForTimeout,
    timeout: body.timeout,
    headers: body.headers,
    userAgent: body.userAgent,
    retries: body.retries,
    provider: body.provider,
    signal: c.req.raw.signal,
  };
}
