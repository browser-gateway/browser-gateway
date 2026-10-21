import type { Logger } from "pino";
import type { ProfileStore } from "../../core/profile/store.js";
import type { ProfileSettings } from "../../core/profile/types.js";

type SettingsSource = { getSettings?(id: string): Promise<ProfileSettings | null> };
import type { GatewayConfig } from "../../core/types.js";
import { applySessionDefaultsWithProfileProxy, sessionProfileId } from "../../core/session-defaults.js";

/** The saved proxy a profile keeps, if it still exists; a missing one is logged and ignored. */
export async function profileProxyFor(
  store: SettingsSource | undefined,
  config: GatewayConfig,
  profileId: string | null,
  logger?: Logger,
): Promise<string | null> {
  if (!profileId || !store?.getSettings) return null;
  const name = (await store.getSettings(profileId).catch(() => null))?.proxy ?? null;
  if (!name) return null;
  if (!config.proxies[name]) {
    logger?.warn({ profileId, proxy: name }, "profile proxy no longer exists; using the default proxy setting");
    return null;
  }
  return name;
}

/** Applies session defaults to a connection url, with the profile's proxy ahead of the default proxy. */
export async function applySessionDefaultsForUrl(
  url: URL,
  config: GatewayConfig,
  store: SettingsSource | undefined,
  logger?: Logger,
  defaults = config.sessionDefaults,
): Promise<URL> {
  const proxy = url.searchParams.has("proxy") ? null : await profileProxyFor(store, config, sessionProfileId(url, defaults), logger);
  return applySessionDefaultsWithProfileProxy(url, defaults, proxy);
}

/** Profiles whose settings name this proxy. */
export async function profilesUsingProxy(store: ProfileStore, proxyName: string): Promise<string[]> {
  if (!store.getSettings) return [];
  const ids: string[] = [];
  for (const meta of await store.list()) {
    const settings = await store.getSettings(meta.id).catch(() => null);
    if (settings?.proxy === proxyName) ids.push(meta.id);
  }
  return ids;
}
