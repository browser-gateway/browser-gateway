/** Shared provider-form types + constants consumed by both OSS and SaaS dashboards. */

export interface HeaderRow {
  id: string;
  key: string;
  value: string;
}

export interface ProviderShape {
  slug: string;
  url: string;
  priority?: number;
  weight?: number;
  maxConcurrent?: number;
  profile?: string;
  headers?: Record<string, string>;
}

export interface ProfileSummary {
  slug: string;
}

export interface SiblingProvider {
  slug: string;
  priority: number;
  weight: number;
}

export const HEADER_LIMITS = {
  maxHeaders: 20,
  keyMaxLength: 80,
  valueMaxLength: 4096,
} as const;

export const PROVIDER_LIMITS = {
  slugMinLength: 1,
  slugMaxLength: 64,
  slugPattern: /^[a-z0-9-]+$/,
} as const;

export const DEFAULT_PRIORITY = 100;
export const DEFAULT_WEIGHT = 100;
