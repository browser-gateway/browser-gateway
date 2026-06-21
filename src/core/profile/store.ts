import type { ProfileMeta } from "./types.js";

export type LockToken = string;

export interface ProfileStore {
  /** Read encrypted profile blob bytes. Returns null if not found. */
  getRaw(id: string): Promise<Buffer | null>;

  /** Write encrypted profile blob bytes. Atomic — readers see old or new, never partial. */
  putRaw(id: string, blob: Buffer): Promise<void>;

  /** Delete a profile. No-op if not found. */
  delete(id: string): Promise<void>;

  /** List profile metadata. Does not read blob contents. */
  list(): Promise<ProfileMeta[]>;

  /** Acquire exclusive lock on a profile id. Returns null if held by another process. */
  lock(id: string, ttlMs: number): Promise<LockToken | null>;

  /** Release a lock previously acquired with lock(). Idempotent. */
  unlock(id: string, token: LockToken): Promise<void>;
}
