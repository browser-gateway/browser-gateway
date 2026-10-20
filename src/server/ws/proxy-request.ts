import type { Gateway } from "../../core/index.js";
import { isDirectBrowserProxy, parseProxyUrl, type ParsedProxy } from "../../core/proxy-config.js";
import { isEligibleProviderForProxy } from "../../core/providers/effective.js";

export interface RequestedProxy {
  name: string;
  proxy: ParsedProxy;
  bypass?: string[];
}

export type ProxyRequestResult =
  | { ok: true; requested: RequestedProxy | null }
  | { ok: false; status: number; body: Record<string, unknown> };

/** Resolves `?proxy=<name>` against the configured proxies; refuses anything the gateway cannot apply. */
export function resolveRequestedProxy(
  gateway: Gateway,
  url: URL,
  context: { targetProviderId?: string },
): ProxyRequestResult {
  const name = url.searchParams.get("proxy");
  if (name === null) return { ok: true, requested: null };
  const entry = gateway.config.proxies[name];
  if (!entry) {
    return { ok: false, status: 400, body: { error: `Proxy '${name}' not configured`, availableProxies: Object.keys(gateway.config.proxies) } };
  }
  const parsed = parseProxyUrl(entry.url);
  if (!parsed.ok) return { ok: false, status: 400, body: { error: `Proxy '${name}' is invalid: ${parsed.reason}` } };
  if (!isDirectBrowserProxy(parsed.proxy)) {
    return {
      ok: false,
      status: 400,
      body: { error: `Proxy '${name}' uses a password or https, which a browser cannot apply on its own. Use an http or socks5 proxy without a password.` },
    };
  }
  const eligible = gateway.registry.getAll().filter((p) => isEligibleProviderForProxy(p.config, parsed.proxy));
  const pinned = context.targetProviderId;
  if (eligible.length === 0 || (pinned !== undefined && !eligible.some((p) => p.id === pinned))) {
    return {
      ok: false,
      status: 400,
      body: { error: `No provider can apply proxy '${name}'. Proxies apply only to browsers you run, marked with injectProxy: true.` },
    };
  }
  return { ok: true, requested: { name, proxy: parsed.proxy, bypass: entry.bypass } };
}
