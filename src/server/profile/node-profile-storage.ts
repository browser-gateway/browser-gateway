import type { CapturedProfile } from "../../core/profile/index.js";
import {
  decodeBlob,
  decodeBlobHeader,
  encodeBlob,
} from "../../core/profile/index.js";
import type { ProfileStore } from "../../core/profile/store.js";
import type {
  LoadedProfile,
  LockToken,
  ProfileStorage,
} from "../../pipeline/plugins/profile-storage.js";

/** Node-side {@link ProfileStorage} adapter. Wraps the existing
 *  {@link ProfileStore} (filesystem-backed today) + a DEK key ring for
 *  encryption/decryption. Pairs with the OSS server tier. */
export class NodeProfileStorage implements ProfileStorage {
  constructor(
    private readonly store: ProfileStore,
    private readonly dekByVersion: ReadonlyMap<number, Buffer>,
    private readonly currentDekVersion: number,
  ) {}

  async load(profileId: string): Promise<LoadedProfile | null> {
    const blob = await this.store.getRaw(profileId);
    if (!blob) return null;

    const header = decodeBlobHeader(blob);
    const dek = this.dekByVersion.get(header.dekVersion);
    if (!dek) {
      throw new Error(`profile blob references DEK version ${header.dekVersion} not in key ring`);
    }

    let plaintext: Buffer;
    try {
      plaintext = decodeBlob(blob, dek, profileId);
    } catch (err) {
      throw new Error(
        `failed to decrypt profile: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    let profile: CapturedProfile;
    try {
      profile = JSON.parse(plaintext.toString("utf-8")) as CapturedProfile;
    } catch (err) {
      throw new Error(
        `profile decoded but JSON malformed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    return { profile, dekVersion: header.dekVersion };
  }

  async save(profileId: string, profile: CapturedProfile): Promise<void> {
    const dek = this.dekByVersion.get(this.currentDekVersion);
    if (!dek) {
      throw new Error(`current DEK version ${this.currentDekVersion} missing from key ring`);
    }
    const plaintext = Buffer.from(JSON.stringify(profile), "utf-8");
    const { bytes } = encodeBlob(dek, this.currentDekVersion, plaintext, profileId);
    await this.store.putRaw(profileId, bytes);
  }

  async acquireLock(profileId: string, ttlMs: number): Promise<LockToken | null> {
    return this.store.lock(profileId, ttlMs);
  }

  async releaseLock(profileId: string, token: LockToken): Promise<void> {
    await this.store.unlock(profileId, token);
  }
}
