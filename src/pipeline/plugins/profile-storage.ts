import type { CapturedProfile } from "../../core/profile/types.js";

export type LockToken = string;

export interface LoadedProfile {
  profile: CapturedProfile;
  /** DEK version the blob was encrypted under (for logging). */
  dekVersion: number;
}

/** Storage backend for {@link ProfilePlugin}. Node adapter reads/writes a
 *  local filesystem via the existing `ProfileStore`; a Workers adapter can
 *  wire R2 + a D1 profile_lock table against the same interface. */
export interface ProfileStorage {
  /** Load an existing profile blob and decrypt it. Returns `null` if no
   *  such profile exists yet (new-profile flow). Throws on decrypt failure
   *  or unknown DEK version. */
  load(profileId: string): Promise<LoadedProfile | null>;
  /** Encrypt and persist a captured profile. Called on `onSessionEnd`
   *  after size limits are enforced. */
  save(profileId: string, profile: CapturedProfile): Promise<void>;
  /** Acquire an exclusive lock on the profile. Returns `null` if another
   *  session holds it. TTL guards against stuck locks — the adapter
   *  reclaims expired locks. */
  acquireLock(profileId: string, ttlMs: number): Promise<LockToken | null>;
  /** Release a lock. Idempotent — a token that doesn't match the current
   *  holder is a no-op. */
  releaseLock(profileId: string, token: LockToken): Promise<void>;
}
