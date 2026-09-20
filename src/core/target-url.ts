/** Target-URL guard for the one-shot REST endpoints. Isomorphic: literal-address
 *  checks only, no DNS. The Node server layer adds resolution on top. */

const PRIVATE_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True when the literal address is loopback, link-local, or in a private range. */
export function isPrivateAddress(host: string): boolean {
  const hostname = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (PRIVATE_HOSTNAMES.has(hostname)) return true;
  if (hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;

  const v4 = IPV4_PATTERN.exec(hostname);
  if (v4) {
    const octets = v4.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return true;
    const [a, b] = octets as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0) return true;
    if (a >= 224) return true;
    return false;
  }

  if (hostname.includes(":")) {
    if (hostname === "::" || hostname === "::1") return true;
    if (hostname.startsWith("fe80") || hostname.startsWith("fc") || hostname.startsWith("fd")) return true;
    if (hostname.startsWith("::ffff:")) return isPrivateAddress(hostname.slice(7));
    return false;
  }

  return false;
}

export interface TargetUrlPolicy {
  /** Hostnames exempt from the private-address block (exact match, lowercase). */
  allowedPrivateHosts?: readonly string[];
}

export interface TargetUrlVerdict {
  ok: boolean;
  reason?: string;
  hostname?: string;
}

/**
 * Validates a user-supplied navigation target. Allows `http:` and `https:` only,
 * and refuses hosts that are loopback, link-local, or in a private range unless
 * the policy names them.
 */
export function checkTargetUrl(url: string, policy: TargetUrlPolicy = {}): TargetUrlVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "url must be an absolute http or https URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `url scheme '${parsed.protocol.replace(":", "")}' is not allowed (use http or https)` };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return { ok: false, reason: "url has no host" };
  if (isHostExempt(hostname, policy)) return { ok: true, hostname };
  if (isPrivateAddress(hostname)) {
    return { ok: false, reason: `url host '${hostname}' resolves to a private address; add it to rest.allowedPrivateHosts to allow it` };
  }
  return { ok: true, hostname };
}

/** True when the policy explicitly permits this hostname to be private. */
export function isHostExempt(hostname: string, policy: TargetUrlPolicy): boolean {
  return (policy.allowedPrivateHosts ?? []).some((h) => h.toLowerCase() === hostname);
}
