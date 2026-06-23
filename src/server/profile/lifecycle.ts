import type { Logger } from "pino";
import {
  PROFILE_VERSION,
  captureFullStateViaTransient,
  decodeBlob,
  decodeBlobHeader,
  encodeBlob,
  enforceProfileLimits,
  injectStateEagerViaTransient,
  PROFILE_ID_REGEX,
  type CapturedProfile,
  type CdpCookie,
  type OriginStorage,
  type ProfileLimits,
} from "../../core/profile/index.js";
import type { LockToken, ProfileStore } from "../../core/profile/store.js";

export interface LifecycleOptions {
  /** Lock TTL: maximum time we'll hold a profile lock for one session. */
  lockTtlMs?: number;
  /** Timeout for the inject path (CDP connect + Storage.setCookies). */
  cdpTimeoutMs?: number;
  /**
   * Timeout for the commit path (CDP connect + Storage.getCookies + write).
   * Defaults to cdpTimeoutMs if unset. Splitting them lets the lock be released
   * sooner after disconnect — important for rapid-reconnect agent workflows.
   */
  commitTimeoutMs?: number;
  /** Top-K origins to inject eagerly. Default 20. */
  eagerOriginLimit?: number;
  /** Number of helper pages for parallel inject/capture. Default 4. */
  helperPages?: number;
  /** Size limits enforced on commit. See `enforceProfileLimits`. */
  limits?: ProfileLimits;
}

export interface AcquiredProfile {
  profileId: string;
  lockToken: LockToken;
  /** Cookies parsed from the existing encrypted blob (empty if profile is new). */
  cookies: CdpCookie[];
  /** Per-origin localStorage parsed from the existing blob (empty if new). */
  storage: Record<string, OriginStorage>;
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
  /**
   * In-flight commits. We add a promise here when commit() starts and remove it
   * when it settles. drain() awaits all of these — important so SIGTERM during
   * graceful shutdown doesn't strand a freshly-disconnected session's commit
   * (H1 fix).
   */
  private readonly pendingCommits = new Set<Promise<void>>();
  private draining = false;

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
        return { profileId, lockToken, cookies: [], storage: {}, isExisting: false };
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
      const storage = (parsed.storage && typeof parsed.storage === "object")
        ? parsed.storage as Record<string, OriginStorage>
        : {};
      return { profileId, lockToken, cookies, storage, isExisting: true };
    } catch (err) {
      await this.store.unlock(profileId, lockToken).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Inject acquired state into the provider browser via a transient CDP
   * connection. Cookies always (one CDP call). For localStorage: eager top-K
   * origins by `lastVisitedAt` recency, paralleled across helper pages with
   * `Fetch.fulfillRequest` so each origin costs ~50 ms instead of a real
   * navigation. The rest become "deferred origins" returned to the caller —
   * lazy hydration on Page.frameNavigated (live-view) or PR-2's background
   * loader can pick them up.
   */
  async inject(
    acquired: AcquiredProfile,
    providerWsUrl: string,
  ): Promise<{ injected: number; originsInjected: string[]; originsDeferred: string[] }> {
    if (acquired.cookies.length === 0 && Object.keys(acquired.storage).length === 0) {
      return { injected: 0, originsInjected: [], originsDeferred: [] };
    }
    const cdpTimeoutMs = this.opts.cdpTimeoutMs ?? 10_000;
    const eagerOriginLimit = this.opts.eagerOriginLimit ?? 20;
    const helperPages = this.opts.helperPages ?? 4;

    let result;
    try {
      result = await injectStateEagerViaTransient(
        providerWsUrl,
        {
          version: PROFILE_VERSION,
          capturedAt: new Date().toISOString(),
          cookies: acquired.cookies,
          storage: acquired.storage,
          meta: { capturedOrigins: [], skippedOrigins: [], durationMs: 0 },
        },
        { eagerOriginLimit, helperPages, totalTimeoutMs: cdpTimeoutMs },
      );
    } catch (err) {
      throw new LifecycleError(
        "INJECT_FAILED",
        `state inject failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.logger.info(
      {
        profileId: acquired.profileId,
        cookies: result.cookiesSet,
        originsInjected: result.originsInjected.length,
        originsDeferred: result.originsDeferred.length,
        skippedOrigins: result.skippedOrigins.length,
        durationMs: result.durationMs,
      },
      "profile lifecycle: state injected",
    );
    return {
      injected: result.cookiesSet,
      originsInjected: result.originsInjected,
      originsDeferred: result.originsDeferred,
    };
  }

  /**
   * Capture latest cookies, encrypt + save, release the lock.
   *
   * Errors from the CDP capture step are logged but DO NOT propagate — we still
   * release the lock so the next session can proceed. Previous saved state (if any)
   * is preserved unchanged.
   *
   * H1: the returned Promise is tracked in pendingCommits so drain() can await it.
   * M1: uses commitTimeoutMs (defaults to cdpTimeoutMs) — typically shorter than
   *     the inject timeout so lock is released sooner.
   * M2: if capture returns 0 cookies but the previous saved state had cookies,
   *     we skip the save and log a WARN — preserves the previous state instead of
   *     silently wiping it.
   */
  async commit(acquired: AcquiredProfile, providerWsUrl: string): Promise<void> {
    const promise = this.runCommit(acquired, providerWsUrl);
    this.pendingCommits.add(promise);
    promise.finally(() => this.pendingCommits.delete(promise));
    return promise;
  }

  private async runCommit(acquired: AcquiredProfile, providerWsUrl: string): Promise<void> {
    const commitTimeoutMs = this.opts.commitTimeoutMs ?? this.opts.cdpTimeoutMs ?? 10_000;
    const helperPages = this.opts.helperPages ?? 4;

    try {
      // Single pass: capture cookies + storage for (existing-blob origins) ∪
      // (origins derived from this session's cookies). The
      // includeCookieDerivedOrigins flag does that union internally so we
      // only open one transient WS.
      const captureResult = await captureFullStateViaTransient(
        providerWsUrl,
        Object.keys(acquired.storage),
        { helperPages, totalTimeoutMs: commitTimeoutMs, includeCookieDerivedOrigins: true },
      );

      const cookies = captureResult.cookies;

      // M2: if the captured state would silently destroy previous data, preserve instead.
      if (cookies.length === 0 && acquired.cookies.length > 0) {
        this.logger.warn(
          {
            profileId: acquired.profileId,
            previousCookies: acquired.cookies.length,
          },
          "profile lifecycle: captured 0 cookies but previous state had cookies — preserving previous state, not overwriting",
        );
        return;
      }

      // Merge: keep older-origin entries that the fresh capture missed (origin
      // not visited this session). Newly-captured origins replace the previous.
      const mergedStorage: Record<string, OriginStorage> = { ...acquired.storage };
      for (const [origin, data] of Object.entries(captureResult.storage)) {
        mergedStorage[origin] = data;
      }

      const profile: CapturedProfile = {
        version: PROFILE_VERSION,
        capturedAt: new Date().toISOString(),
        cookies,
        storage: mergedStorage,
        meta: {
          capturedOrigins: Object.keys(captureResult.storage),
          skippedOrigins: captureResult.skippedOrigins,
          durationMs: captureResult.durationMs,
        },
      };

      // Enforce size limits BEFORE encrypting/persisting. Evicts oldest
      // origins by lastVisitedAt when the serialized blob would exceed
      // hardCapBytes; warns when it would exceed softWarnBytes.
      const enforced = enforceProfileLimits(profile, this.opts.limits);
      if (enforced.refused) {
        this.logger.warn(
          {
            profileId: acquired.profileId,
            bytes: enforced.bytes,
            reason: enforced.refusedReason,
          },
          "profile lifecycle: refused to save — previous state preserved",
        );
        return;
      }
      if (enforced.evictedOrigins.length > 0) {
        this.logger.info(
          {
            profileId: acquired.profileId,
            evicted: enforced.evictedOrigins.length,
            evictedOrigins: enforced.evictedOrigins.slice(0, 5),
            bytes: enforced.bytes,
          },
          "profile lifecycle: evicted oldest origins to fit budget",
        );
      }
      if (enforced.softWarn) {
        this.logger.warn(
          { profileId: acquired.profileId, bytes: enforced.bytes },
          "profile lifecycle: profile exceeds soft-warn threshold",
        );
      }

      const plaintext = Buffer.from(JSON.stringify(enforced.profile), "utf-8");
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

  /**
   * Wait for all in-flight commits to finish, up to timeoutMs.
   *
   * Call this during graceful shutdown after the gateway stops accepting new
   * connections — it lets the last few sessions persist their cookies before
   * the process exits.
   *
   * Once draining starts, the gateway should not be accepting new sessions, so
   * the pending set should drain to empty quickly.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.draining = true;
    if (this.pendingCommits.size === 0) return;

    this.logger.info(
      { pending: this.pendingCommits.size, timeoutMs },
      "profile lifecycle: draining in-flight commits",
    );

    const allDone = Promise.allSettled(Array.from(this.pendingCommits));
    const deadline = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), timeoutMs),
    );

    const result = await Promise.race([allDone.then(() => "done" as const), deadline]);
    if (result === "timeout") {
      this.logger.warn(
        { remaining: this.pendingCommits.size, timeoutMs },
        "profile lifecycle: drain timeout — some commits did not finish",
      );
    } else {
      this.logger.info("profile lifecycle: drain complete");
    }
  }

  /** Test/observability hook — number of in-flight commits right now. */
  pendingCommitCount(): number {
    return this.pendingCommits.size;
  }

  /** True after drain() has been called. */
  isDraining(): boolean {
    return this.draining;
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
