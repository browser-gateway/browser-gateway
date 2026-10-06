export interface UrlPolicy {
  /** Only these hosts (and their subdomains) may be opened. */
  allowedHosts?: string[];
  /** Refuse localhost, link-local and private-network addresses written as IPs. Default true. */
  blockPrivateNetworks?: boolean;
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Normalises an address the model asked to open and refuses anything but
 *  http(s) on an allowed host. A missing scheme means https. */
export function checkUrl(input: string, policy: UrlPolicy = {}): string {
  const raw = input.trim();
  if (!raw) throw new Error("no address given");
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/:]+:\d+(\/|$)/.test(raw);
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    throw new Error(`"${raw}" is not a valid web address`);
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new Error(`only http and https addresses can be opened, not ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  if (policy.blockPrivateNetworks !== false && isPrivateHost(host)) {
    throw new Error(`${host} is a local or private network address and cannot be opened`);
  }
  if (policy.allowedHosts && !policy.allowedHosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`))) {
    throw new Error(`${host} is not on the list of sites this session may open`);
  }
  return url.toString();
}

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    return v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("::ffff:");
  }
  return false;
}
