/**
 * Profile size limits + LRU origin eviction.
 *
 * Without bounds, a profile blob can grow indefinitely as the user visits
 * more sites. Storage is expensive on three axes — disk, inject latency, and
 * memory during decode. We enforce two thresholds:
 *
 *   - `softWarnBytes` (default 5 MB): the lifecycle logs WARN once per
 *     commit. The dashboard surfaces this via the Profiles page.
 *   - `hardCapBytes` (default 50 MB): we evict origins (oldest by
 *     lastVisitedAt) until the serialized blob fits under the cap. If
 *     even an empty-storage blob is over the cap (huge cookie jar), we
 *     refuse to save and preserve the previous blob unchanged.
 *
 * Default thresholds match the spec in
 * planning/research/v0.3.0-PROFILE-INJECT-OPTIMIZATION.md §4.
 */
import type { CapturedProfile, OriginStorage } from "./types.js";

export interface ProfileLimits {
  /** Log WARN if serialized profile exceeds this. Default 5 MB. */
  softWarnBytes?: number;
  /** Hard cap — evict origins to fit. Default 50 MB. */
  hardCapBytes?: number;
  /**
   * Maximum origins allowed in a profile. Default 1000. Once exceeded, the
   * least-recently-visited origins are dropped.
   */
  maxOrigins?: number;
}

export interface EnforceResult {
  /** Final profile to persist. Same identity as input if no changes. */
  profile: CapturedProfile;
  /** Serialized byte length of the FINAL profile. */
  bytes: number;
  /** Origins removed during enforcement (LRU eviction). */
  evictedOrigins: string[];
  /**
   * True if the serialized size exceeds `softWarnBytes`. Caller should log
   * a WARN and surface a banner on the dashboard. Note the soft warn is on
   * the FINAL size (after any eviction).
   */
  softWarn: boolean;
  /** Always false if we succeeded; true if we couldn't fit and refused. */
  refused: boolean;
  /** Why we refused (if refused). */
  refusedReason?: string;
}

export const DEFAULT_PROFILE_LIMITS = {
  softWarnBytes: 5 * 1024 * 1024,
  hardCapBytes: 50 * 1024 * 1024,
  maxOrigins: 1000,
} as const;

/**
 * Enforce limits on a profile before persisting. Mutates a *copy* — input is
 * untouched. Caller persists `result.profile` and uses `result.bytes`,
 * `result.refused`, `result.softWarn`, `result.evictedOrigins` for logging.
 */
export function enforceProfileLimits(
  profile: CapturedProfile,
  limits: ProfileLimits = {},
): EnforceResult {
  const softWarnBytes = limits.softWarnBytes ?? DEFAULT_PROFILE_LIMITS.softWarnBytes;
  const hardCapBytes = limits.hardCapBytes ?? DEFAULT_PROFILE_LIMITS.hardCapBytes;
  const maxOrigins = limits.maxOrigins ?? DEFAULT_PROFILE_LIMITS.maxOrigins;

  const evicted: string[] = [];
  // Work on a shallow clone — storage gets mutated.
  let storage = { ...profile.storage };

  // Step 1: maxOrigins cap. Drop oldest by lastVisitedAt.
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

  // Step 2: if still over the hard cap, evict oldest one at a time until we
  // fit OR we run out of origins to evict.
  while (bytes > hardCapBytes && Object.keys(current.storage).length > 0) {
    const oldest = pickOldestOrigin(current.storage);
    if (!oldest) break;
    delete current.storage[oldest];
    evicted.push(oldest);
    bytes = serializedSize(current);
  }

  // Step 3: if even the cookie-only path is too big, refuse.
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

/** JSON-stringify + measure (utf-8 byte length). Encoding matches what we'd write to disk before AES-GCM. */
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
