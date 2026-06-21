import type { Logger } from "pino";
import {
  PROFILE_VERSION,
  captureCookiesViaTransient,
  decodeBlob,
  decodeBlobHeader,
  encodeBlob,
  injectCookiesViaTransient,
  PROFILE_ID_REGEX,
  type CapturedProfile,
  type CdpCookie,
} from "../../core/profile/index.js";
import type { LockToken, ProfileStore } from "../../core/profile/store.js";

export interface LifecycleOptions {
  /** Lock TTL: maximum time we'll hold a profile lock for one session. */
  lockTtlMs?: number;
  /** Timeout for transient CDP connect + ops at session boundaries. */
  cdpTimeoutMs?: number;
}

export interface AcquiredProfile {
  profileId: string;
  lockToken: LockToken;
  /** Cookies parsed from the existing encrypted blob (empty if profile is new). */
  cookies: CdpCookie[];
  /** True if the store had an existing entry for this profile id. */
  isExisting: boolean;
}

export type LifecycleFailureReason =
  | "INVALID_ID"
  | "LOCK_HELD"
  | "DECRYPT_FAILED"
  | "INJECT_FAILED"
  | "UNKNOWN_DEK_VERSION";

export class LifecycleError extends Error {
  constructor(
    public readonly reason: LifecycleFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "LifecycleError";
  }
}

/**
 * Orchestrates a profile's lifecycle around one gateway WebSocket session.
 *
 * Four phases:
 *   1. acquire(profileId)             — lock + decrypt + return cookies to inject
 *   2. inject(acquired, wsUrl)        — push cookies into provider via transient CDP
 *   3. commit(acquired, wsUrl)        — capture latest cookies + encrypt + save + release lock
 *   4. release(acquired)              — release lock without saving (use after a failed session)
 *
 * Splitting them lets the upgrade handler acquire the lock early (fail-fast on contention)
 * and inject only after a provider has been selected. inject() can be retried against
 * a different provider if the first connection attempt fails.
 */
export class ProfileLifecycle {
  constructor(
    private readonly store: ProfileStore,
    private readonly dekByVersion: ReadonlyMap<number, Buffer>,
    private readonly currentDekVersion: number,
    private readonly logger: Logger,
    private readonly opts: LifecycleOptions = {},
  ) {}

  /** Acquire the profile lock and decrypt the stored blob if any. */
  async acquire(profileId: string): Promise<AcquiredProfile> {
    if (!PROFILE_ID_REGEX.test(profileId)) {
      throw new LifecycleError("INVALID_ID", `invalid profile id: "${profileId}"`);
    }

    const lockTtlMs = this.opts.lockTtlMs ?? 5 * 60_000;
    const lockToken = await this.store.lock(profileId, lockTtlMs);
    if (!lockToken) {
      throw new LifecycleError("LOCK_HELD", `profile "${profileId}" is in use by another session`);
    }

    try {
      const blob = await this.store.getRaw(profileId);
      if (!blob) {
        return { profileId, lockToken, cookies: [], isExisting: false };
      }

      const header = decodeBlobHeader(blob);
      const dek = this.dekByVersion.get(header.dekVersion);
      if (!dek) {
        throw new LifecycleError(
          "UNKNOWN_DEK_VERSION",
          `profile blob references DEK version ${header.dekVersion} not in the key ring`,
        );
      }

      let plaintext: Buffer;
      try {
        plaintext = decodeBlob(blob, dek, profileId);
      } catch (err) {
        throw new LifecycleError(
          "DECRYPT_FAILED",
          `failed to decrypt profile: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      let parsed: CapturedProfile;
      try {
        parsed = JSON.parse(plaintext.toString("utf-8")) as CapturedProfile;
      } catch (err) {
        throw new LifecycleError(
          "DECRYPT_FAILED",
          `profile decoded but JSON malformed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
      return { profileId, lockToken, cookies, isExisting: true };
    } catch (err) {
      await this.store.unlock(profileId, lockToken).catch(() => undefined);
      throw err;
    }
  }

  /** Inject acquired cookies into the provider browser via a transient CDP connection. */
  async inject(acquired: AcquiredProfile, providerWsUrl: string): Promise<{ injected: number }> {
    if (acquired.cookies.length === 0) {
      return { injected: 0 };
    }
    const cdpTimeoutMs = this.opts.cdpTimeoutMs ?? 10_000;
    try {
      await injectCookiesViaTransient(providerWsUrl, acquired.cookies, cdpTimeoutMs);
    } catch (err) {
      throw new LifecycleError(
        "INJECT_FAILED",
        `cookie inject failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.logger.info(
      { profileId: acquired.profileId, cookies: acquired.cookies.length },
      "profile lifecycle: cookies injected",
    );
    return { injected: acquired.cookies.length };
  }

  /**
   * Capture latest cookies, encrypt + save, release the lock.
   *
   * Errors from the CDP capture step are logged but DO NOT propagate — we still
   * release the lock so the next session can proceed. Previous saved state (if any)
   * is preserved unchanged.
   */
  async commit(acquired: AcquiredProfile, providerWsUrl: string): Promise<void> {
    const cdpTimeoutMs = this.opts.cdpTimeoutMs ?? 10_000;

    try {
      const cookies = await captureCookiesViaTransient(providerWsUrl, cdpTimeoutMs);
      const profile: CapturedProfile = {
        version: PROFILE_VERSION,
        capturedAt: new Date().toISOString(),
        cookies,
        storage: {},
        meta: {
          capturedOrigins: [],
          skippedOrigins: [],
          durationMs: 0,
        },
      };

      const plaintext = Buffer.from(JSON.stringify(profile), "utf-8");
      const dek = this.dekByVersion.get(this.currentDekVersion);
      if (!dek) {
        this.logger.error(
          { profileId: acquired.profileId, dekVersion: this.currentDekVersion },
          "profile lifecycle: current DEK missing, skipping save",
        );
      } else {
        const { bytes } = encodeBlob(dek, this.currentDekVersion, plaintext, acquired.profileId);
        await this.store.putRaw(acquired.profileId, bytes);
        this.logger.info(
          { profileId: acquired.profileId, cookies: cookies.length, bytes: bytes.length },
          "profile lifecycle: state saved",
        );
      }
    } catch (err) {
      this.logger.warn(
        {
          profileId: acquired.profileId,
          error: err instanceof Error ? err.message : String(err),
        },
        "profile lifecycle: capture/save failed, previous state preserved",
      );
    } finally {
      await this.release(acquired);
    }
  }

  /** Release the lock without saving anything (e.g. session never connected). */
  async release(acquired: AcquiredProfile): Promise<void> {
    await this.store.unlock(acquired.profileId, acquired.lockToken).catch((err) => {
      this.logger.warn(
        { profileId: acquired.profileId, error: err instanceof Error ? err.message : String(err) },
        "profile lifecycle: unlock failed (will recover via stale TTL)",
      );
    });
  }
}
