interface CdpVersionInfo {
  browser?: string;
  webSocketDebuggerUrl?: string;
  protocolVersion?: string;
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

export async function probeCdpEndpoint(
  url: string,
  timeoutMs: number = 5000,
): Promise<{ ok: boolean; latencyMs: number; browser?: string; wsUrl?: string; error?: string }> {
  const start = Date.now();
  try {
    const data = await fetchCdpVersion(url, timeoutMs);
    return {
      ok: true,
      latencyMs: Date.now() - start,
      browser: data.browser,
      wsUrl: data.webSocketDebuggerUrl,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: (err as Error).message,
    };
  }
}
