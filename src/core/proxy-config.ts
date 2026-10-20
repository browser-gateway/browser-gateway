import { z } from "zod";
import { isPrivateAddress } from "./target-url.js";

export const PROXY_SCHEMES = ["http", "https", "socks5", "socks5h"] as const;
export type ProxyScheme = (typeof PROXY_SCHEMES)[number];

const MAX_PROXY_URL_LENGTH = 2048;
const MAX_BYPASS_ENTRIES = 100;
const DEFAULT_PORTS: Record<ProxyScheme, number> = { http: 80, https: 443, socks5: 1080, socks5h: 1080 };

export interface ParsedProxy {
  scheme: ProxyScheme;
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** `scheme://host:port` with no credentials, the form a browser takes as its proxy server. */
  server: string;
}

export interface ProxyParseOptions {
  /** Refuse loopback, link-local and private-range hosts. Set wherever the gateway runs on shared infrastructure. */
  rejectPrivateHosts?: boolean;
}

export type ProxyParseResult = { ok: true; proxy: ParsedProxy } | { ok: false; reason: string };

/** Parses and validates a proxy URL. Never echoes the input in the reason, so it is safe to log or return. */
export function parseProxyUrl(raw: string, opts: ProxyParseOptions = {}): ProxyParseResult {
  if (raw.length > MAX_PROXY_URL_LENGTH) return { ok: false, reason: "proxy url is too long" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "proxy url must look like scheme://[user:password@]host:port" };
  }
  const scheme = url.protocol.slice(0, -1) as ProxyScheme;
  if (!PROXY_SCHEMES.includes(scheme)) {
    return { ok: false, reason: `proxy scheme must be one of ${PROXY_SCHEMES.join(", ")}` };
  }
  if (!url.hostname) return { ok: false, reason: "proxy url has no host" };
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    return { ok: false, reason: "proxy url must not contain a path, query or fragment" };
  }
  const username = url.username ? decodeURIComponent(url.username) : undefined;
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  if (opts.rejectPrivateHosts && isPrivateAddress(url.hostname)) {
    return { ok: false, reason: "proxy host is a private or internal address" };
  }
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[scheme];
  return {
    ok: true,
    proxy: { scheme, host: url.hostname, port, username, password, server: `${scheme}://${url.host || url.hostname}` },
  };
}

/** True when a browser can use the proxy directly through its proxy setting, with no relay in between. */
export function isDirectBrowserProxy(proxy: ParsedProxy): boolean {
  return proxy.scheme !== "https" && !proxy.username && !proxy.password;
}

export const ProxyConfigSchema = z
  .object({
    url: z.string().min(1),
    bypass: z.array(z.string().min(1).max(253)).max(MAX_BYPASS_ENTRIES).optional(),
  })
  .superRefine((value, ctx) => {
    const parsed = parseProxyUrl(value.url);
    if (!parsed.ok) ctx.addIssue({ code: "custom", path: ["url"], message: parsed.reason });
  });

export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

/** Value of `?proxy=` and `?profile=` that means "none for this connection"; never usable as a name. */
export const RESERVED_NONE_NAME = "none";

/** True when `name` can be used for a saved proxy or profile. */
export function isAllowedResourceName(name: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(name) && name.toLowerCase() !== RESERVED_NONE_NAME;
}

/** Proxy fields as a form sends them. An empty username or password keeps the saved one. */
export interface ProxyInput {
  address: string;
  username?: string;
  password?: string;
  bypass?: string[];
  clearCredentials?: boolean;
}

function withUserinfo(server: string, username: string | undefined, password: string | undefined): string {
  if (username === undefined && password === undefined) return server;
  const userinfo = `${encodeURIComponent(username ?? "")}${password === undefined ? "" : `:${encodeURIComponent(password)}`}@`;
  const split = server.indexOf("://") + 3;
  return `${server.slice(0, split)}${userinfo}${server.slice(split)}`;
}

/** Builds a stored proxy entry from form fields, keeping the saved credentials of `existing` unless replaced or cleared. */
export function buildProxyConfig(
  input: ProxyInput,
  existing?: ProxyConfig,
): { ok: true; config: ProxyConfig } | { ok: false; reason: string } {
  const parsed = parseProxyUrl(input.address.trim());
  if (!parsed.ok) return parsed;
  const saved = existing && !input.clearCredentials ? parseProxyUrl(existing.url) : null;
  const previous = saved?.ok ? saved.proxy : undefined;
  const username = input.username?.trim() || parsed.proxy.username || previous?.username;
  const password = input.password || parsed.proxy.password || previous?.password;
  const bypass = (input.bypass ?? []).map((b) => b.trim()).filter(Boolean);
  const candidate = { url: withUserinfo(parsed.proxy.server, username, password), ...(bypass.length ? { bypass } : {}) };
  const checked = ProxyConfigSchema.safeParse(candidate);
  if (!checked.success) return { ok: false, reason: checked.error.issues.map((i) => i.message).join("; ") };
  return { ok: true, config: checked.data };
}

/** A configured proxy as the dashboard and REST API show it: never carries credentials. */
export interface ProxySummary {
  name: string;
  /** `scheme://host:port`, or null when the URL does not parse. */
  server: string | null;
  bypass: string[];
  /** True when a browser can apply it on its own (no password, not https). */
  usable: boolean;
  reason?: string;
  /** True when a username or password is saved; the values themselves are never returned. */
  hasCredentials: boolean;
}

/** Describes each configured proxy for display, without its credentials. */
export function describeProxies(proxies: Record<string, ProxyConfig>): ProxySummary[] {
  return Object.entries(proxies).map(([name, entry]) => {
    const parsed = parseProxyUrl(entry.url);
    const bypass = entry.bypass ?? [];
    if (!parsed.ok) return { name, server: null, bypass, usable: false, reason: parsed.reason, hasCredentials: false };
    const hasCredentials = parsed.proxy.username !== undefined || parsed.proxy.password !== undefined;
    if (!isDirectBrowserProxy(parsed.proxy)) {
      return { name, server: parsed.proxy.server, bypass, usable: false, reason: "uses a password or https, which a browser cannot apply on its own", hasCredentials };
    }
    return { name, server: parsed.proxy.server, bypass, usable: true, hasCredentials };
  });
}
