import { z } from "zod";
import { RESERVED_NONE_NAME } from "./proxy-config.js";

export const SessionDefaultsSchema = z.object({
  record: z.boolean().default(false),
  profile: z.string().min(1).nullable().default(null),
  saveProfile: z.boolean().default(false),
  proxy: z.string().min(1).nullable().default(null),
});

export type SessionDefaults = z.infer<typeof SessionDefaultsSchema>;

const isNone = (value: string | null): boolean => value !== null && value.toLowerCase() === RESERVED_NONE_NAME;

/**
 * Fills the gateway's session defaults into a connection url wherever the url
 * leaves a setting out, and drops `profile=none` / `proxy=none`. A default
 * profile opens read-only unless `saveProfile` is on or the url sets `readOnly`.
 * Returns `url` itself when nothing changes.
 */
export function applySessionDefaults(url: URL, defaults: SessionDefaults): URL {
  const edits: Array<(params: URLSearchParams) => void> = [];
  const params = url.searchParams;
  if (defaults.record && !params.has("session_record")) edits.push((p) => p.set("session_record", "true"));

  const profile = params.get("profile");
  const defaultProfile = defaults.profile;
  if (isNone(profile)) {
    edits.push((p) => { p.delete("profile"); p.delete("readOnly"); });
  } else if (profile === null && defaultProfile) {
    edits.push((p) => {
      p.set("profile", defaultProfile);
      if (!p.has("readOnly")) p.set("readOnly", defaults.saveProfile ? "0" : "1");
    });
  }

  const proxy = params.get("proxy");
  const defaultProxy = defaults.proxy;
  if (isNone(proxy)) edits.push((p) => p.delete("proxy"));
  else if (proxy === null && defaultProxy) edits.push((p) => p.set("proxy", defaultProxy));

  if (edits.length === 0) return url;
  const next = new URL(url.href);
  for (const edit of edits) edit(next.searchParams);
  return next;
}

/** The profile a connection url will use once defaults apply, or null for none. */
export function sessionProfileId(url: URL, defaults: SessionDefaults): string | null {
  const profile = url.searchParams.get("profile");
  if (isNone(profile)) return null;
  return profile ?? defaults.profile ?? null;
}

/**
 * `applySessionDefaults` with the profile's own proxy between the url and the
 * gateway default: a url that names a proxy (or `none`) keeps it, otherwise the
 * profile's proxy is used, otherwise the default proxy.
 */
export function applySessionDefaultsWithProfileProxy(url: URL, defaults: SessionDefaults, profileProxy: string | null): URL {
  if (!profileProxy || url.searchParams.has("proxy")) return applySessionDefaults(url, defaults);
  const next = new URL(url.href);
  next.searchParams.set("proxy", profileProxy);
  return applySessionDefaults(next, defaults);
}
