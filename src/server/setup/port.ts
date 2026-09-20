export function resolvePort(cliOverride: string | undefined): number | undefined {
  const raw = cliOverride ?? process.env.PORT;
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Bind interface. `HOST` always wins. Without `BG_TOKEN` every `/v1/*` route is
 * unauthenticated, so the default is loopback — reaching the gateway from another
 * machine requires either a token or an explicit `HOST=0.0.0.0`.
 */
export function resolveHost(): string {
  if (process.env.HOST) return process.env.HOST;
  return process.env.BG_TOKEN ? "0.0.0.0" : "127.0.0.1";
}

/**
 * Public base URL the gateway advertises to clients, with no trailing slash.
 * `BG_PUBLIC_URL` wins; otherwise it is built from the bind interface and port.
 *
 * Never derive this from a request's `Host` header: the value is handed to an
 * agent as the endpoint to connect to, so a reflected header is a redirect
 * primitive. The host guard restricts who may reach the route, it does not make
 * the header trustworthy.
 */
export function resolvePublicUrl(port: number): string {
  const configured = process.env.BG_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const bind = resolveHost();
  const host = bind === "0.0.0.0" || bind === "::" ? "localhost" : bind;
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}
