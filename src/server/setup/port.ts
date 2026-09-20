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
