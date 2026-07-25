/**
 * Public subpath for consumers that want ONLY the routing/health primitives
 * (selection strategies, cooldown tracker, capacity helpers) without pulling
 * in the Node.js server code.
 *
 * Intended for alternate hosts — Cloudflare Workers, Bun, Deno — where the
 * OSS `Gateway` class (Node timers + EventEmitter) doesn't fit but the
 * selection LOGIC does. Consumers supply their own `ProviderStore` adapter
 * over their state store (D1, KV, Postgres, memory, etc.), hydrate
 * `ProviderState` per request, and drive `ProviderSelector` + `CooldownTracker`
 * with the same semantics as the OSS gateway.
 *
 * Zero Node imports here — safe from any TS runtime.
 */

export { ProviderSelector, type Strategy, type SelectOptions } from "./router/selector.js";
export { CooldownTracker } from "./tracking/cooldown.js";
export { ConcurrencyTracker } from "./tracking/concurrency.js";
export {
  hasFreeSlot,
  effectiveMaxConcurrent,
  isEligibleForProfile,
  isEligibleProviderForProfile,
} from "./providers/effective.js";
export type { ProviderStore } from "./providers/registry.js";
export type { ProviderConfig, ProviderState } from "./types.js";
export { ProviderConfigSchema } from "./types.js";
