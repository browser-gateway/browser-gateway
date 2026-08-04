/** Isomorphic aggregate — every export here is safe to import from Cloudflare Workers,
 *  Deno, Bun, or any runtime without Node.js `net`/`tls`/`ws`. Anything requiring the
 *  full Node.js gateway server (upgrade handler, http listener, CLI) is not exported
 *  here — those consumers should import from the package root `browser-gateway`. */

// Zod schemas + core config types
export * from "./core/types.js";

// Provider auto-detection
export * from "./core/auto-detect.js";

// Selection + routing primitives
export * from "./core/selection.js";

// Transport interface
export * from "./core/transport.js";

// Webhook delivery
export * from "./core/webhooks.js";

// Profile types + envelope crypto
export * from "./core/profile/types.js";
export * from "./core/profile/crypto.js";

// Replay session log types
export * from "./server/replay/types.js";

// CDP protocol client (bring-your-own transport)
export * from "./core/cdp/protocol.js";

// Capability probe with pluggable client
export * from "./core/providers/capabilities-with-client.js";
export {
  UNKNOWN_CAPABILITIES,
  type CapabilityState,
  type ProbeOptions,
  type ProviderCapabilities,
} from "./core/providers/capabilities.js";

// Provider connection test with pluggable client
export {
  testConnectionWithClient,
  type TestConnectionClient,
  type TestConnectionResult,
} from "./core/providers/test-connection.js";

// Profile inject + capture — isomorphic helpers callable against any
// HelperPoolCdpClient (WsCDPClient on Node, RouterCdpClient on Workers,
// PluginCdpClient inside a Pipeline). Used by ProfilePlugin internally, but
// also directly by consumers that manage their own CDP wire (e.g. SaaS
// /v1/live handler that pre-injects before its LiveRelayDO takes over).
export type { HelperPoolCdpClient } from "./core/profile/helper-pool-client.js";
export {
  injectStateEager,
  type EagerInjectOptions,
  type EagerInjectResult,
} from "./core/profile/inject-eager.js";
export {
  captureFullStateOnClient,
  type CaptureFullOptions,
  type CaptureFullResult,
} from "./core/profile/capture-full.js";
export { PROFILE_VERSION, PROFILE_ID_REGEX } from "./core/profile/index.js";
export { mergeAndPrepareProfile } from "./core/profile/save.js";
