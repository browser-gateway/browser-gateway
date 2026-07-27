/** Public subpath for provider auto-detection. Isomorphic — uses global fetch. */

export {
  UNKNOWN_IDENTITY,
  fetchProviderIdentity,
  httpDiscoveryUrl,
  type ProviderIdentity,
} from "./providers/cdp.js";
