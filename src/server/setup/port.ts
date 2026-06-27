/**
 * Resolve the HTTP listen port. Precedence:
 *
 *   1. CLI `--port` flag (operator-explicit, wins)
 *   2. `PORT` env var (12-factor convention used by Railway, Render, Fly,
 *      Heroku — also what Railway's healthcheck probes)
 *
 * Returns `undefined` when no source is set — caller falls back to whatever
 * `config.gateway.port` already has from gateway.yml / its schema default.
 */
export function resolvePort(cliOverride: string | undefined): number | undefined {
  const raw = cliOverride ?? process.env.PORT;
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve the bind interface. Default `0.0.0.0` (reachable on any iface).
 * Setting `HOST=127.0.0.1` binds to loopback only — useful when fronting
 * with nginx on the same host or running on a shared VM.
 */
export function resolveHost(): string {
  return process.env.HOST ?? "0.0.0.0";
}
