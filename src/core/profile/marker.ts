/**
 * Provider residue marker: a small sentinel planted at profile-inject time on
 * an external CDP provider so a subsequent session can detect whether the browser
 * instance currently holds a different profile's state. The marker's presence is
 * the mechanism by which we reject `?profile=B` when the underlying browser was
 * last used for profile A and its residue hasn't been cleared.
 *
 * We plant TWO independent surfaces because different provider behaviours leak
 * different things:
 *   1. Cookie on synthetic domain `__bg-marker.internal` — persists when the
 *      provider reuses the same browser context between sessions.
 *   2. localStorage entry on synthetic origin `https://__bg-marker.internal` —
 *      persists when the provider spawns a NEW BrowserContext per session but
 *      reuses the underlying Chromium process. Chromium bugs 754576 +
 *      puppeteer#11627 (devtools-protocol#43) mean localStorage keys survive
 *      `disposeBrowserContext` and reappear in the next context. Cookie-only
 *      detection misses this, which is exactly the class of leak we're
 *      preventing. Cross-ref: `planning/research/v0.4-ISOLATION-RUNTIME-AUTOSCALE.md`
 *      §"Question 1" and `planning/project/SILENT-LEAK-LEDGER.md`.
 *
 * Both surfaces are filtered out of the captured profile blob so they never
 * get persisted or replayed to users' real browsers.
 */

export const MARKER_DOMAIN = "__bg-marker.internal";
export const MARKER_ORIGIN = "https://__bg-marker.internal";
export const MARKER_NAME = "_bg_marker";
export const MARKER_STORAGE_KEY = "_bg_marker";

export interface ProviderMarker {
  profileId: string;
  workspaceId?: string;
  injectedAtMs: number;
}

export interface MarkerCookieLike {
  name: string;
  domain?: string;
}

/** True when a cookie is a gateway-planted residue marker (should never be captured). */
export function isMarkerCookie(cookie: MarkerCookieLike): boolean {
  if (cookie.name !== MARKER_NAME) return false;
  const domain = cookie.domain ?? "";
  return domain === MARKER_DOMAIN || domain === `.${MARKER_DOMAIN}`;
}

/** base64-encode marker payload; isomorphic (btoa is available in Node 16+, Workers, browsers). */
export function encodeMarker(m: ProviderMarker): string {
  const json = JSON.stringify(m);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/** Reverse of encodeMarker. Returns null when the cookie value isn't a well-formed marker. */
export function decodeMarker(value: string): ProviderMarker | null {
  try {
    const bin = atob(value);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const json = new TextDecoder().decode(bytes);
    const obj = JSON.parse(json) as unknown;
    if (typeof obj !== "object" || obj === null) return null;
    const rec = obj as Record<string, unknown>;
    if (typeof rec.profileId !== "string" || typeof rec.injectedAtMs !== "number") return null;
    return {
      profileId: rec.profileId,
      injectedAtMs: rec.injectedAtMs,
      workspaceId: typeof rec.workspaceId === "string" ? rec.workspaceId : undefined,
    };
  } catch {
    return null;
  }
}

/** Filters gateway-planted marker cookies out of a cookie array before profile capture. */
export function filterMarkerCookies<T extends MarkerCookieLike>(cookies: T[]): T[] {
  return cookies.filter((c) => !isMarkerCookie(c));
}

/** True when an origin is the synthetic marker origin (with or without trailing slash). */
export function isMarkerOrigin(origin: string): boolean {
  return origin === MARKER_ORIGIN || origin === `${MARKER_ORIGIN}/`;
}

/** Removes the marker localStorage entry from an origin's storage snapshot in place.
 *  Returns the mutated snapshot so it can be chained. */
export function stripMarkerFromStorage(
  localStorageMap: Record<string, string>,
): Record<string, string> {
  delete localStorageMap[MARKER_STORAGE_KEY];
  return localStorageMap;
}

/** Removes the whole marker origin entry from a captured `storage` map. Used on the
 *  capture path so the marker never appears in a saved profile blob. */
export function stripMarkerOrigin<T>(storage: Record<string, T>): Record<string, T> {
  for (const key of Object.keys(storage)) {
    if (isMarkerOrigin(key)) delete storage[key];
  }
  return storage;
}
