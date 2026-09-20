import type { MiddlewareHandler } from "hono";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ALLOWED_CONTENT_TYPES = ["application/json", "application/octet-stream"];

function hasBody(c: { req: { header: (name: string) => string | undefined; raw: Request } }): boolean {
  const length = c.req.header("content-length");
  if (length !== undefined) return Number(length) > 0;
  if (c.req.header("transfer-encoding")) return true;
  return c.req.raw.body !== null;
}

/**
 * Blocks the two shapes a cross-origin page can use to reach a mutating route
 * without a CORS preflight: a body sent under a form/text content type, and a
 * bodyless request. A request with `Sec-Fetch-Site: cross-site` is refused with
 * 403; a body under any other content type is refused with 415.
 */
export function mutatingRequestGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (!MUTATING_METHODS.has(c.req.method)) return next();

    if (c.req.header("sec-fetch-site")?.toLowerCase() === "cross-site") {
      return c.json({ error: "Cross-site request rejected" }, 403);
    }

    if (hasBody(c)) {
      const contentType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
        return c.json(
          {
            error: "Unsupported Media Type",
            message: "Send Content-Type: application/json on requests with a body.",
          },
          415,
        );
      }
    }

    return next();
  };
}
