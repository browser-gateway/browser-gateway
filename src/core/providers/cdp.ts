interface CdpVersionInfo {
  browser?: string;
  webSocketDebuggerUrl?: string;
  protocolVersion?: string;
}

/** Vendor fields a provider may advertise on its CDP discovery endpoint. */
export interface ProviderIdentity {
  /** Set when the provider is a browserserve instance. */
  browserserveVersion: string | null;
  /** The provider's self-reported safe concurrency ceiling, when advertised. */
  advertisedMaxConcurrent: number | null;
}

export const UNKNOWN_IDENTITY: Readonly<ProviderIdentity> = Object.freeze({
  browserserveVersion: null,
  advertisedMaxConcurrent: null,
});

/**
 * Derives the HTTP `/json/version` discovery URL for a provider URL of any
 * scheme. CDP servers serve discovery over HTTP on the same host/port as the
 * WebSocket endpoint; auth query params are preserved.
 */
export function httpDiscoveryUrl(providerUrl: string): string {
  const parsed = new URL(providerUrl);
  const scheme = parsed.protocol === "wss:" || parsed.protocol === "https:" ? "https:" : "http:";
  return `${scheme}//${parsed.host}/json/version${parsed.search}`;
}

/**
 * Reads a provider's vendor identity from its `/json/version` response.
 * Best-effort: any failure (unreachable, non-JSON, missing fields) returns
 * {@link UNKNOWN_IDENTITY} rather than throwing.
 */
export async function fetchProviderIdentity(
  providerUrl: string,
  timeoutMs: number = 3000,
): Promise<ProviderIdentity> {
  try {
    const res = await fetch(httpDiscoveryUrl(providerUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return UNKNOWN_IDENTITY;
    const data = (await res.json()) as Record<string, unknown>;
    const version = data["Browserserve-Version"];
    const advertised = data["Browserserve-MaxConcurrent"];
    return {
      browserserveVersion: typeof version === "string" && version.length > 0 ? version : null,
      advertisedMaxConcurrent:
        typeof advertised === "number" && Number.isInteger(advertised) && advertised > 0
          ? advertised
          : null,
    };
  } catch {
    return UNKNOWN_IDENTITY;
  }
}

export async function fetchCdpVersion(
  httpUrl: string,
  timeoutMs: number = 3000,
): Promise<CdpVersionInfo> {
  const versionUrl = `${httpUrl.replace(/\/$/, "")}/json/version`;
  const res = await fetch(versionUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as CdpVersionInfo;
}

export function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

export async function resolveWsUrl(
  providerUrl: string,
  timeoutMs: number = 3000,
): Promise<string> {
  if (!isHttpUrl(providerUrl)) return providerUrl;

  const parsed = new URL(providerUrl);
  const data = await fetchCdpVersion(providerUrl, timeoutMs);

  if (data.webSocketDebuggerUrl) {
    const wsUrl = new URL(data.webSocketDebuggerUrl);
    wsUrl.hostname = parsed.hostname;
    wsUrl.port = parsed.port;
    return wsUrl.toString();
  }

  return providerUrl;
}

