/**
 * Startup banner for `browser-gateway serve`.
 *
 * DX inspiration: Vite (clean URL list) + Next.js (▲ + "ready in Xms" timing)
 * + Wrangler (structured feature rows). The goal is a banner that's scannable
 * in 2 seconds, prints once on startup, and uses ANSI colors when the terminal
 * supports them (TTY). Non-TTY output falls back to plain text so log files
 * and CI runs stay readable.
 *
 * Banner content is intentionally separate from `pino` structured logs —
 * those continue as JSON for log aggregators while the human-readable banner
 * goes straight to stdout.
 */
import type { GatewayConfig, ProviderState } from "../../core/types.js";

const isTTY = process.stdout.isTTY && process.env.NO_COLOR === undefined;

// ANSI helpers — only emit codes when the TTY supports them.
const c = {
  reset: isTTY ? "\x1b[0m" : "",
  bold: isTTY ? "\x1b[1m" : "",
  dim: isTTY ? "\x1b[2m" : "",
  cyan: isTTY ? "\x1b[36m" : "",
  green: isTTY ? "\x1b[32m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  red: isTTY ? "\x1b[31m" : "",
  gray: isTTY ? "\x1b[90m" : "",
  bg: isTTY ? "\x1b[1;36m" : "", // bold cyan for the brand mark
};

// Strip CSI SGR sequences (ESC[<numbers>m) before measuring visible width.
// Built from String.fromCharCode(27) so lint doesn't flag the ESC byte as a
// control character in a regex literal.
const ANSI_CSI_PATTERN = new RegExp(
  String.fromCharCode(27) + "\\[\\d+(;\\d+)*m",
  "g",
);

function pad(s: string, n: number): string {
  const visible = s.replace(ANSI_CSI_PATTERN, "");
  if (visible.length >= n) return s;
  return s + " ".repeat(n - visible.length);
}

function arrow(label: string, value: string): string {
  return `  ${c.green}➜${c.reset}  ${pad(label, 16)} ${c.cyan}${value}${c.reset}`;
}

function row(label: string, value: string): string {
  return `  ${pad(label, 19)}${value}`;
}

export interface BannerOptions {
  version: string;
  port: number;
  /** Whether the dashboard is being served. */
  hasDashboard: boolean;
  /** Whether BG_TOKEN is set. */
  authEnabled: boolean;
  /** Profiles status — affects which line we print. */
  profilesStatus: "enabled" | "disabled";
  /** Compute health summary from gateway.registry. */
  providers: ProviderState[];
  /** Wall-clock milliseconds from process start. */
  readyMs: number;
  config: GatewayConfig;
}

export function printStartupBanner(opts: BannerOptions): void {
  const {
    version,
    port,
    hasDashboard,
    authEnabled,
    profilesStatus,
    providers,
    readyMs,
    config,
  } = opts;

  const base = `http://localhost:${port}`;
  const wsBase = `ws://localhost:${port}`;

  const lines: string[] = [];
  lines.push("");
  lines.push(
    `  ${c.bg}▲${c.reset} ${c.bold}browser-gateway${c.reset} ${c.gray}v${version}${c.reset}  ${c.dim}ready in ${readyMs}ms${c.reset}`,
  );
  lines.push("");

  lines.push(arrow("Gateway:", base));
  if (hasDashboard) lines.push(arrow("Dashboard:", `${base}/web`));
  lines.push(arrow("WS endpoint:", `${wsBase}/v1/connect`));
  lines.push("");

  const strategy = config.gateway.defaultStrategy;
  const healthyCount = providers.filter((p) => p.healthy).length;
  const total = providers.length;
  lines.push(
    row(
      "Providers:",
      total === 0
        ? `${c.yellow}none configured${c.reset}  ${c.dim}(add to gateway.yml)${c.reset}`
        : `${c.bold}${total}${c.reset} ${c.dim}configured  •  ${strategy} strategy${c.reset}`,
    ),
  );
  for (const p of providers) {
    const mark = p.healthy ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    const maskedUrl = maskUrl(p.config.url);
    lines.push(`    ${mark} ${pad(p.id, 22)}${c.dim}${maskedUrl}${c.reset}`);
  }
  // Use healthyCount in a status hint when there's at least one provider but
  // some are degraded — keeps the symbol's value visible even when not every
  // provider is up.
  if (total > 0 && healthyCount < total) {
    lines.push(
      `    ${c.yellow}${healthyCount}/${total} healthy${c.reset}`,
    );
  }
  if (total > 0) lines.push("");

  lines.push(
    row(
      "Profiles:",
      profilesStatus === "enabled"
        ? `${c.green}enabled${c.reset}`
        : `${c.gray}disabled${c.reset}  ${c.dim}(set profiles.enabled: true in gateway.yml)${c.reset}`,
    ),
  );
  lines.push(
    row(
      "Auth:",
      authEnabled
        ? `${c.green}enabled${c.reset}  ${c.dim}(BG_TOKEN set)${c.reset}`
        : `${c.yellow}disabled${c.reset}  ${c.dim}(set BG_TOKEN to require a token)${c.reset}`,
    ),
  );
  lines.push(
    row("MCP:", `${c.green}enabled${c.reset}  ${c.dim}(POST ${base}/mcp)${c.reset}`),
  );

  const pool = config.pool;
  lines.push(
    row(
      "Pool:",
      `${c.dim}${pool.minSessions}..${pool.maxSessions} sessions, ${pool.maxPagesPerSession} pages/session${c.reset}`,
    ),
  );

  lines.push("");
  lines.push(`  ${c.dim}Press Ctrl+C to stop${c.reset}`);
  lines.push("");
  lines.push(`  ${c.dim}by Monostellar Labs · https://monostellar.com${c.reset}`);
  lines.push("");

  process.stdout.write(lines.join("\n") + "\n");
}

/** Hide query-string secrets like ?token=... or ?apiKey=... before printing. */
function maskUrl(url: string): string {
  return url.replace(/([?&])(token|apiKey|key|secret|password)=[^&]*/gi, "$1$2=***");
}
