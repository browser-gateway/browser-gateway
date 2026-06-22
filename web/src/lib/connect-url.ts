/**
 * Connect URL helpers — used by the Overview "Connection Endpoint" card, the
 * "Quick start" integration tabs, the New Profile dialog, and the per-row
 * Copy WS URL button on the Profiles page.
 *
 * Why we fetch the real BG_TOKEN from the gateway: the dashboard logs in with
 * the token, gets a cookie HMAC'd against it, and then needs to display the
 * connect URL with the actual token baked in so the user can copy-paste it
 * into their code. The gateway already trusts the caller (they proved they
 * know the token), so returning it via /v1/auth/info is no privilege
 * escalation.
 *
 * Display strategy: the rendered URL ALWAYS shows the token masked
 * (`abc•••xyz`). The copy button writes the real URL. Users never see the
 * raw token on screen by accident — but a copy gives them something that
 * works without manual substitution.
 */

export function buildConnectUrl(profileId?: string, token?: string | null): string {
  const base = wsBase();
  const params: string[] = [];
  if (profileId) params.push(`profile=${encodeURIComponent(profileId)}`);
  if (token) params.push(`token=${token}`);
  const query = params.length > 0 ? "?" + params.join("&") : "";
  return `${base}/v1/connect${query}`;
}

function wsBase(): string {
  if (typeof window === "undefined") return "ws://localhost:9500";
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  // Dev mode: Next is on :9501, gateway is on :9500. Rewrite port if we're
  // hitting the dev server (in prod the dashboard is served by the gateway
  // directly so host already matches).
  const host = window.location.host.includes("9501")
    ? window.location.host.replace("9501", "9500")
    : window.location.host;
  return `${scheme}://${host}`;
}

/**
 * Mask a token for display.
 * - Shorter than 8 chars → all dots
 * - 8+ chars → first 3 + middle dots + last 3 (e.g. `abc••••••xyz`)
 */
export function maskToken(token: string | null | undefined): string {
  if (!token) return "";
  if (token.length <= 8) return "•".repeat(Math.max(8, token.length));
  return `${token.slice(0, 3)}${"•".repeat(Math.max(6, token.length - 6))}${token.slice(-3)}`;
}

/** Mask any `token=...` query param in a URL for display, keeping the rest intact. */
export function maskUrlToken(url: string): string {
  return url.replace(/(\btoken=)([^&\s]+)/g, (_, prefix, val) => `${prefix}${maskToken(val)}`);
}

/** Mirror of PROFILE_ID_REGEX from src/core/profile/types.ts. */
export const PROFILE_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function validateProfileId(id: string): { ok: true } | { ok: false; reason: string } {
  if (!id) return { ok: false, reason: "Profile id is required." };
  if (id.length > 128) return { ok: false, reason: "Profile id is too long (max 128 characters)." };
  if (!PROFILE_ID_REGEX.test(id)) {
    return {
      ok: false,
      reason: "Profile id must start with a letter or number and can only contain letters, numbers, dots, dashes, and underscores.",
    };
  }
  return { ok: true };
}
