export function resolvePort(cliOverride: string | undefined): number | undefined {
  const raw = cliOverride ?? process.env.PORT;
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function resolveHost(): string {
  return process.env.HOST ?? "0.0.0.0";
}
