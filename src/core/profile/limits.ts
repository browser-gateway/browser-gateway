import type { CapturedProfile, OriginStorage } from "./types.js";

export interface ProfileLimits {
  /** Log WARN if serialized profile exceeds this. Default 5 MB. */
  softWarnBytes?: number;
  /** Hard cap — evict origins to fit. Default 50 MB. */
  hardCapBytes?: number;
  /** Maximum origins allowed. Default 1000. Oldest-by-visit are evicted first. */
  maxOrigins?: number;
}

export interface EnforceResult {
  /** Final profile to persist. Same identity as input if no changes. */
  profile: CapturedProfile;
  /** Serialized byte length of the FINAL profile. */
  bytes: number;
  /** Origins removed during enforcement (LRU eviction). */
  evictedOrigins: string[];
  /** True if the FINAL serialized size exceeds `softWarnBytes`. */
  softWarn: boolean;
  /** True if the profile could not be fit under `hardCapBytes`. */
  refused: boolean;
  /** Reason set when `refused` is true. */
  refusedReason?: string;
}

export const DEFAULT_PROFILE_LIMITS = {
  softWarnBytes: 5 * 1024 * 1024,
  hardCapBytes: 50 * 1024 * 1024,
  maxOrigins: 1000,
} as const;

/** Enforces size and origin-count caps on a profile. Returns a new profile; input untouched. */
export function enforceProfileLimits(
  profile: CapturedProfile,
  limits: ProfileLimits = {},
): EnforceResult {
  const softWarnBytes = limits.softWarnBytes ?? DEFAULT_PROFILE_LIMITS.softWarnBytes;
  const hardCapBytes = limits.hardCapBytes ?? DEFAULT_PROFILE_LIMITS.hardCapBytes;
  const maxOrigins = limits.maxOrigins ?? DEFAULT_PROFILE_LIMITS.maxOrigins;

  const evicted: string[] = [];
  let storage = { ...profile.storage };

  const originEntries = Object.entries(storage);
  if (originEntries.length > maxOrigins) {
    const ranked = originEntries
      .map(([origin, data]) => ({ origin, ts: data.lastVisitedAt ? Date.parse(data.lastVisitedAt) : 0 }))
      .sort((a, b) => b.ts - a.ts);
    const keep = new Set(ranked.slice(0, maxOrigins).map((x) => x.origin));
    storage = {};
    for (const [origin, data] of originEntries) {
      if (keep.has(origin)) {
        storage[origin] = data;
      } else {
        evicted.push(origin);
      }
    }
  }

  const current = { ...profile, storage };
  let bytes = serializedSize(current);

  while (bytes > hardCapBytes && Object.keys(current.storage).length > 0) {
    const oldest = pickOldestOrigin(current.storage);
    if (!oldest) break;
    delete current.storage[oldest];
    evicted.push(oldest);
    bytes = serializedSize(current);
  }

  if (bytes > hardCapBytes) {
    return {
      profile,
      bytes,
      evictedOrigins: evicted,
      softWarn: true,
      refused: true,
      refusedReason: `serialized profile exceeds hardCapBytes (${bytes} > ${hardCapBytes}) even with all origins removed`,
    };
  }

  return {
    profile: current,
    bytes,
    evictedOrigins: evicted,
    softWarn: bytes > softWarnBytes,
    refused: false,
  };
}

function serializedSize(profile: CapturedProfile): number {
  return Buffer.byteLength(JSON.stringify(profile), "utf-8");
}

function pickOldestOrigin(storage: Record<string, OriginStorage>): string | null {
  let oldest: { origin: string; ts: number } | null = null;
  for (const [origin, data] of Object.entries(storage)) {
    const ts = data.lastVisitedAt ? Date.parse(data.lastVisitedAt) : 0;
    if (!oldest || ts < oldest.ts) oldest = { origin, ts };
  }
  return oldest?.origin ?? null;
}
