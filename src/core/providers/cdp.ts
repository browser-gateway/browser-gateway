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

