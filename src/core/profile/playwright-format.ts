import { z } from "zod";
import { PROFILE_VERSION, type CapturedProfile, type OriginStorage } from "./types.js";
import type { CdpCookie } from "./cdp.js";

const SAME_SITE_VALUES = ["Strict", "Lax", "None"] as const;

export const PlaywrightCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(SAME_SITE_VALUES).optional(),
});

export const PlaywrightOriginSchema = z.object({
  origin: z.string().url(),
  localStorage: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .default([]),
});

export const PlaywrightStorageStateSchema = z.object({
  cookies: z.array(PlaywrightCookieSchema).default([]),
  origins: z.array(PlaywrightOriginSchema).default([]),
});

export type PlaywrightCookie = z.infer<typeof PlaywrightCookieSchema>;
export type PlaywrightOrigin = z.infer<typeof PlaywrightOriginSchema>;
export type PlaywrightStorageState = z.infer<typeof PlaywrightStorageStateSchema>;

/**
 * Convert a captured profile to Playwright's `storageState` JSON shape.
 * Only fields Playwright understands are emitted. sessionStorage is dropped
 * (Playwright's `storageState` does not carry it — matches Playwright behaviour).
 * indexeddb + browserserve native files are dropped (Playwright cannot restore them).
 */
export function capturedProfileToStorageState(
  profile: CapturedProfile,
): PlaywrightStorageState {
  const cookies: PlaywrightCookie[] = profile.cookies.map(cdpCookieToPlaywright);
  const origins: PlaywrightOrigin[] = [];
  for (const [origin, entries] of Object.entries(profile.storage)) {
    const localStorage = Object.entries(entries.localStorage ?? {}).map(
      ([name, value]) => ({ name, value }),
    );
    origins.push({ origin, localStorage });
  }
  return { cookies, origins };
}

/**
 * Convert a Playwright `storageState` JSON to a captured profile.
 * Cookies missing sameSite fall through to CDP default (Lax).
 * sessionStorage is initialised empty (Playwright does not carry it).
 * Throws z.ZodError when the input does not match the schema.
 */
export function storageStateToCapturedProfile(input: unknown): CapturedProfile {
  const parsed = PlaywrightStorageStateSchema.parse(input);
  const cookies: CdpCookie[] = parsed.cookies.map(playwrightCookieToCdp);
  const storage: Record<string, OriginStorage> = {};
  const capturedOrigins: string[] = [];
  for (const entry of parsed.origins) {
    const localStorage: Record<string, string> = {};
    for (const kv of entry.localStorage) localStorage[kv.name] = kv.value;
    storage[entry.origin] = { localStorage, sessionStorage: {} };
    capturedOrigins.push(entry.origin);
  }
  return {
    version: PROFILE_VERSION,
    capturedAt: new Date().toISOString(),
    cookies,
    storage,
    meta: {
      capturedOrigins,
      skippedOrigins: [],
      durationMs: 0,
    },
  };
}

function cdpCookieToPlaywright(cookie: CdpCookie): PlaywrightCookie {
  const out: PlaywrightCookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires ?? -1,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
  };
  if (cookie.sameSite) out.sameSite = cookie.sameSite;
  return out;
}

function playwrightCookieToCdp(cookie: PlaywrightCookie): CdpCookie {
  const out: CdpCookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
  };
  if (cookie.expires !== -1) out.expires = cookie.expires;
  out.sameSite = cookie.sameSite ?? "Lax";
  return out;
}
