/** Isomorphic shared logic for the OSS and SaaS provider forms. Pure TS, no React. */

export type {
  HeaderRow,
  ProviderShape,
  ProfileSummary,
  SiblingProvider,
} from "./types.js";
export {
  HEADER_LIMITS,
  PROVIDER_LIMITS,
  DEFAULT_PRIORITY,
  DEFAULT_WEIGHT,
} from "./types.js";

export {
  computePriorityEffect,
  computeWeightEffect,
  type PriorityEffect,
  type WeightEffect,
} from "./effect.js";

export {
  slugifyProviderName,
  isValidProviderUrl,
  validateProviderSlug,
  validateProviderUrl,
  validatePositiveInteger,
  validateHeaderRows,
  headersToRecord,
  recordToHeaderRows,
} from "./validate.js";

export { PROVIDER_FORM_COPY } from "./copy.js";

export {
  isProbeableUrl,
  providerProbeCacheKey,
  selectProfileHint,
  type ProviderProbeFn,
  type ProviderProbeKind,
  type ProviderProbeResult,
  type ProviderProbeState,
} from "./probe.js";
