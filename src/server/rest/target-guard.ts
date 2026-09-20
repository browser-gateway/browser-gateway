import { lookup } from "node:dns/promises";
import { checkTargetUrl, isHostExempt, isPrivateAddress, type TargetUrlPolicy } from "../../core/target-url.js";

/**
 * Scheme + address check on a REST target URL, with DNS resolution so a public
 * name pointing at a private address is caught too. Returns null when allowed,
 * otherwise the reason to return to the caller.
 */
export async function rejectUnsafeTargetUrl(
  url: string,
  policy: TargetUrlPolicy,
): Promise<string | null> {
  const verdict = checkTargetUrl(url, policy);
  if (!verdict.ok) return verdict.reason ?? "url is not allowed";

  const hostname = verdict.hostname!;
  if (isHostExempt(hostname, policy)) return null;

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    return null;
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      return `url host '${hostname}' resolves to the private address ${address}; add it to rest.allowedPrivateHosts to allow it`;
    }
  }
  return null;
}
