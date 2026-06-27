/**
 * Resolve the HTTP listen port from the available sources in precedence order:
 *
 *   1. CLI `--port` flag (operator-explicit, wins)
 *   2. `BG_PORT` env var (gateway-native, documented)
 *   3. `PORT` env var (12-factor convention used by Railway, Render, Fly,
 *      Heroku — Railway's healthcheck probes this port specifically, so the
 *      gateway respecting it makes the image work out of the box without
 *      per-platform env-var docs)
 *
 * Returns `undefined` when no source is set — caller falls back to whatever
 * `config.gateway.port` already has from gateway.yml / its schema default.
 */
export function resolvePort(cliOverride: string | undefined): number | undefined {
  const raw = cliOverride ?? process.env.BG_PORT ?? process.env.PORT;
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}
