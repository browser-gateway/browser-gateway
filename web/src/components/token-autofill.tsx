"use client";

/**
 * `useGatewayToken()` — single source of truth for the BG_TOKEN on the
 * dashboard. The dashboard already proved it knows the token (HMAC'd into the
 * session cookie at login), so it can fetch the literal value from
 * GET /v1/auth/info without any privilege escalation.
 *
 * Cached at module scope so concurrent components don't fire N parallel
 * requests. Components subscribe via `useGatewayToken()` and re-render once
 * the fetch lands.
 *
 * The token is NEVER rendered raw on screen — call `maskToken()` from
 * `lib/connect-url` for display, and use the unmasked value only inside copy
 * handlers.
 */
import { useEffect, useState } from "react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined" && window.location.port === "9501"
    ? "http://localhost:9500"
    : "");

let cached: { token: string | null; authEnabled: boolean } | null = null;
let inflight: Promise<{ token: string | null; authEnabled: boolean }> | null = null;

async function fetchAuthInfo(): Promise<{ token: string | null; authEnabled: boolean }> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/v1/auth/info`, { credentials: "include" });
      if (!res.ok) {
        cached = { token: null, authEnabled: false };
        return cached;
      }
      const body = (await res.json()) as { token: string | null; authEnabled: boolean };
      cached = { token: body.token, authEnabled: body.authEnabled };
      return cached;
    } catch {
      cached = { token: null, authEnabled: false };
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useGatewayToken(): string | null {
  const [token, setToken] = useState<string | null>(cached?.token ?? null);
  useEffect(() => {
    if (cached) {
      setToken(cached.token);
      return;
    }
    fetchAuthInfo().then((info) => setToken(info.token));
  }, []);
  return token;
}

export function useAuthEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(cached?.authEnabled ?? false);
  useEffect(() => {
    if (cached) {
      setEnabled(cached.authEnabled);
      return;
    }
    fetchAuthInfo().then((info) => setEnabled(info.authEnabled));
  }, []);
  return enabled;
}
