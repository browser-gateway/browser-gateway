/**
 * Auto-generate REST API reference MDX for the docs site.
 *
 * Scans app.ts + rest/*.ts for `app.<verb>("/path", ...)` and `rest.<verb>(...)`
 * calls, applies mount prefixes, groups by resource, emits one MDX file per
 * resource to the docs repo at ../docs/content/docs/rest-api/.
 *
 * Descriptions come from the JSDoc block immediately above each route (if
 * present) or from a hand-maintained `RESOURCE_HELP` map at the top of this
 * file.
 *
 * Run: `npm run docs:gen-rest`
 * Check: `npm run docs:check-rest` fails if any code route is missing from docs.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DOCS_OUT = resolve(REPO_ROOT, "../docs/content/docs/rest-api");

interface RouteEntry {
  method: string;
  path: string;
  file: string;
  line: number;
  jsdoc: string | null;
}

interface SourceFile {
  file: string;
  variable: "app" | "rest";
  mountPrefix: string;
}

const SOURCES: SourceFile[] = [
  { file: "src/server/app.ts", variable: "app", mountPrefix: "" },
  { file: "src/server/rest/index.ts", variable: "rest", mountPrefix: "/v1" },
  { file: "src/server/rest/profiles.ts", variable: "app", mountPrefix: "/v1" },
  { file: "src/server/rest/replays.ts", variable: "app", mountPrefix: "/v1" },
];

const RESOURCE_HELP: Record<string, { title: string; description: string; overview: string }> = {
  health: {
    title: "Health",
    description: "Liveness probe. Always public, no auth required.",
    overview: "Returns HTTP 200 with a timestamp when the gateway is running. Use this for uptime monitoring, container health checks, and load-balancer liveness probes.",
  },
  status: {
    title: "Status",
    description: "Aggregate gateway status (providers, sessions, pool).",
    overview: "Reports every configured provider's health, session count, cooldown state, average latency, and the current pool metrics. The dashboard polls this every 5 seconds.",
  },
  sessions: {
    title: "Sessions",
    description: "Read-only view of active WebSocket sessions.",
    overview: "Returns the list of currently connected sessions with their provider, connect timestamp, last activity, and message count.",
  },
  providers: {
    title: "Providers",
    description: "CRUD for provider entries in gateway.yml.",
    overview: "Add, list, update, delete, and test browser provider entries. Adding via API writes to `gateway.yml` on disk atomically.",
  },
  config: {
    title: "Config",
    description: "Read, validate, and update gateway.yml over HTTP.",
    overview: "Read the running configuration, validate a proposed YAML, or replace the whole config file. All writes are fsync'd and backed up.",
  },
  profiles: {
    title: "Profiles",
    description: "Create, export, import, delete stored browser profiles.",
    overview: "Manage profiles stored on disk. Profiles hold cookies + localStorage + IndexedDB, encrypted at rest with a key you control. See [Profiles](/profiles) for the conceptual model.",
  },
  replays: {
    title: "Replays",
    description: "List, fetch, delete session replay frames.",
    overview: "Session replays are CDP screencast recordings captured during routed sessions. See [Session Replays](/replays) for the storage model.",
  },
  screenshot: {
    title: "Screenshot",
    description: "One-shot screenshot of any URL, no client code required.",
    overview: "Sends a page load + screenshot request to a browser session from the pool. Supports viewport, format (png/jpeg), clip regions, full-page, and profile injection.",
  },
  content: {
    title: "Content",
    description: "Extract page content (HTML, markdown, or text) from any URL.",
    overview: "Loads a page in a pooled browser and returns the requested content format. Supports selector-scoped extraction and profile injection.",
  },
  scrape: {
    title: "Scrape",
    description: "Structured data extraction from a page.",
    overview: "Loads a page in a pooled browser and extracts data via CSS selectors or a page script. Supports profile injection.",
  },
  auth: {
    title: "Auth Info",
    description: "Report whether the gateway requires an auth token.",
    overview: "Returns whether `BG_TOKEN` is set. Used by the dashboard to decide whether to show the login screen.",
  },
  "json/version": {
    title: "Chrome Compat",
    description: "Chrome-compatible /json/version endpoint.",
    overview: "Mimics Chrome's DevTools discovery endpoint so tools that expect `http://host:port/json/version` (Puppeteer defaults, chrome-launcher) work with the gateway as a drop-in.",
  },
  web: {
    title: "Dashboard",
    description: "Dashboard static files + login endpoints.",
    overview: "Serves the dashboard from `/web/*` and handles HttpOnly-cookie login at `/web/auth`. Not intended for programmatic use.",
  },
};

function extractRoutes(file: string, variable: string, mountPrefix: string): RouteEntry[] {
  const abs = resolve(REPO_ROOT, file);
  if (!existsSync(abs)) return [];
  const source = readFileSync(abs, "utf8");
  const lines = source.split("\n");
  const rx = new RegExp(String.raw`^\s*${variable}\.(get|post|put|delete|patch)\("([^"]+)"`);
  const out: RouteEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(rx);
    if (!m) continue;
    const jsdoc = extractJsdocAbove(lines, i);
    out.push({
      method: m[1].toUpperCase(),
      path: mountPrefix + m[2],
      file,
      line: i + 1,
      jsdoc,
    });
  }
  return out;
}

function extractJsdocAbove(lines: string[], routeLine: number): string | null {
  // Walk upward. Skip blank lines. If we hit a `*/`, capture the whole `/** ... */` block.
  let i = routeLine - 1;
  while (i >= 0 && lines[i].trim() === "") i--;
  if (i < 0 || !lines[i].trim().endsWith("*/")) return null;
  const endLine = i;
  let startLine = i;
  while (startLine >= 0 && !lines[startLine].trim().startsWith("/**")) startLine--;
  if (startLine < 0) return null;
  const raw = lines
    .slice(startLine + 1, endLine)
    .map((l) => l.replace(/^\s*\*\s?/, "").trim())
    .filter((l) => l.length > 0)
    .join(" ");
  if (!raw) return null;
  // Scrub em-dashes so source-code stylistic choices don't leak into public docs.
  return raw
    .replace(/ — /g, ". ")
    .replace(/—/g, ".");
}

function resourceKey(path: string): string {
  // /v1/providers/:id/test → "providers"
  // /v1/profiles/:id/export → "profiles"
  // /json/version → "json/version"
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "v1") return segments[1] ?? "root";
  if (segments[0] === "json") return "json/version";
  if (segments[0] === "web") return "web";
  return segments[0] ?? "root";
}

function normalizePath(p: string): string {
  // Strip trailing slashes and Hono's `:name{constraint}` regex suffixes.
  // The constraint is a runtime routing detail, not user-facing surface.
  // Also collapses the constraint variant to the same path as the plain one.
  return p.replace(/\/$/, "").replace(/(:[a-zA-Z_][a-zA-Z0-9_]*)\{[^}]*\}/g, "$1");
}

function renderResource(key: string, routes: RouteEntry[]): string {
  const help = RESOURCE_HELP[key] ?? {
    title: key.replace(/\b\w/g, (m) => m.toUpperCase()),
    description: `HTTP endpoints under /${key.startsWith("v1") ? key : "v1/" + key}.`,
    overview: "",
  };

  const lines: string[] = [
    "---",
    `title: "${help.title}"`,
    `description: "${help.description}"`,
    "---",
    "",
    "{/* AUTO-GENERATED. Do not edit. Regenerate with `npm run docs:gen-rest` in the code repo. */}",
    "{/* Edit descriptions in scripts/gen-rest-docs.ts (RESOURCE_HELP + JSDoc above each route). */}",
    "",
  ];
  if (help.overview) lines.push(help.overview, "");

  lines.push("## Endpoints", "");
  lines.push("| Method | Path | Description |");
  lines.push("|---|---|---|");
  for (const r of routes) {
    const desc = r.jsdoc ? r.jsdoc.replace(/\|/g, "\\|") : "";
    lines.push(`| \`${r.method}\` | \`${r.path}\` | ${desc} |`);
  }
  lines.push("");
  lines.push("## Source", "");
  const uniqueFiles = [...new Set(routes.map((r) => r.file))].sort();
  for (const f of uniqueFiles) {
    lines.push(`- [\`${f}\`](https://github.com/browser-gateway/browser-gateway/blob/main/${f})`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderOverview(all: Record<string, RouteEntry[]>): string {
  const lines: string[] = [
    "---",
    'title: "REST API Reference"',
    'description: "Every HTTP endpoint the gateway exposes, grouped by resource, auto-generated from source."',
    "---",
    "",
    "{/* AUTO-GENERATED. Do not edit. Regenerate with `npm run docs:gen-rest` in the code repo. */}",
    "",
    "The gateway exposes three categories of HTTP endpoints:",
    "",
    "- **Action endpoints** (`/v1/screenshot`, `/v1/content`, `/v1/scrape`): one-shot browser actions, no client code needed.",
    "- **Control endpoints** (`/v1/providers`, `/v1/config`, `/v1/profiles`, `/v1/replays`, `/v1/sessions`, `/v1/status`): manage the gateway itself.",
    "- **Compat + dashboard** (`/health`, `/json/version`, `/web/*`): Chrome-compat endpoints and the dashboard.",
    "",
    "All `/v1/*` endpoints require the `BG_TOKEN` header (or `?token=` query param) if `BG_TOKEN` is set. `/health` and `/json/version` are always public.",
    "",
    "## All endpoints",
    "",
    "| Method | Path | Resource |",
    "|---|---|---|",
  ];
  const sortedKeys = Object.keys(all).sort();
  for (const key of sortedKeys) {
    const help = RESOURCE_HELP[key];
    const title = help?.title ?? key;
    for (const r of all[key]) {
      lines.push(`| \`${r.method}\` | [\`${r.path}\`](/rest-api/${key.replace("/", "-")}) | ${title} |`);
    }
  }
  lines.push("");
  lines.push("## By resource", "");
  for (const key of sortedKeys) {
    const help = RESOURCE_HELP[key];
    const title = help?.title ?? key;
    const desc = help?.description ?? "";
    lines.push(`- [**${title}**](/rest-api/${key.replace("/", "-")}): ${desc}`);
  }
  lines.push("");
  return lines.join("\n");
}

function generate(): { files: Map<string, string>; count: number; resources: number } {
  const all: RouteEntry[] = [];
  for (const s of SOURCES) {
    all.push(...extractRoutes(s.file, s.variable, s.mountPrefix));
  }
  const uniquePaths = new Map<string, RouteEntry>();
  for (const r of all) {
    const cleanPath = normalizePath(r.path);
    const key = `${r.method} ${cleanPath}`;
    if (!uniquePaths.has(key)) uniquePaths.set(key, { ...r, path: cleanPath });
  }
  const unique = [...uniquePaths.values()];

  const grouped: Record<string, RouteEntry[]> = {};
  for (const r of unique) {
    const key = resourceKey(r.path);
    (grouped[key] ??= []).push(r);
  }
  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  }

  const files = new Map<string, string>();
  files.set("index.mdx", renderOverview(grouped));

  const sortedKeys = Object.keys(grouped).sort();
  for (const key of sortedKeys) {
    const slug = key.replace("/", "-");
    files.set(`${slug}.mdx`, renderResource(key, grouped[key]));
  }

  const meta = {
    title: "REST API",
    pages: ["index", ...sortedKeys.map((k) => k.replace("/", "-"))],
  };
  files.set("meta.json", JSON.stringify(meta, null, 2) + "\n");

  return { files, count: unique.length, resources: sortedKeys.length };
}

function writeAll({ files, count, resources }: { files: Map<string, string>; count: number; resources: number }): void {
  if (!existsSync(DOCS_OUT)) mkdirSync(DOCS_OUT, { recursive: true });
  for (const [name, content] of files) {
    const abs = resolve(DOCS_OUT, name);
    writeFileSync(abs, content);
    console.log(`  wrote: ${abs}${name.endsWith(".mdx") && name !== "index.mdx" && name !== "meta.json" ? "" : ""}`);
  }
  console.log(`\n✓ ${count} endpoints across ${resources} resources`);
}

function check({ files }: { files: Map<string, string>; count: number; resources: number }): void {
  const drift: string[] = [];
  for (const [name, expected] of files) {
    const abs = resolve(DOCS_OUT, name);
    if (!existsSync(abs)) {
      drift.push(`  missing on disk: ${name}`);
      continue;
    }
    const actual = readFileSync(abs, "utf8");
    if (actual !== expected) drift.push(`  content drift:   ${name}`);
  }
  if (drift.length === 0) {
    console.log(`✓ REST docs in sync with source (${files.size} files checked)`);
    return;
  }
  console.error("REST docs are stale. Run `npm run docs:gen-rest` in the code repo:\n");
  for (const line of drift) console.error(line);
  process.exit(1);
}

function main(): void {
  const mode = process.argv[2] === "--check" ? "check" : "write";
  const result = generate();
  if (mode === "check") check(result);
  else writeAll(result);
}

main();
