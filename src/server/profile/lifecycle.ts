import type { Logger } from "pino";
import {
  PROFILE_VERSION,
  captureFullStateOnClient,
  captureFullStateViaTransient,
  decodeBlob,
  decodeBlobHeader,
  encodeBlob,
  enforceProfileLimits,
  injectStateEager,
  injectStateEagerViaTransient,
  PROFILE_ID_REGEX,
  type BrowserserveFile,
  type CapturedProfile,
  type CdpCookie,
  type OriginStorage,
  type ProfileLimits,
} from "../../core/profile/index.js";
import type { WsCDPClient } from "../../core/profile/cdp-client.js";
import type { LockToken, ProfileStore } from "../../core/profile/store.js";

export interface LifecycleOptions {
  /** Lock TTL: maximum time we'll hold a profile lock for one session. */
  lockTtlMs?: number;
  /** Timeout for the inject path. */
  cdpTimeoutMs?: number;
  /** Timeout for the commit path. Defaults to `cdpTimeoutMs`. */
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
  /** Lock token from `acquire`; `null` for a read-only acquire (no lock taken). */
  lockToken: LockToken | null;
  /** Read-only session: no lock, and the profile is never saved back. */
  readOnly: boolean;
  /** Cookies parsed from the existing encrypted blob (empty if profile is new). */
  cookies: CdpCookie[];
  /** Per-origin localStorage parsed from the existing blob (empty if new). */
  storage: Record<string, OriginStorage>;
  /** browserserve-native layer (IndexedDB/SW files); empty for external-only profiles. */
  indexeddb: BrowserserveFile[];
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

/** Orchestrates acquire/inject/commit/release for a profile around one session. */
export class ProfileLifecycle {
  private readonly pendingCommits = new Set<Promise<void>>();
  private draining = false;

  constructor(
    private readonly store: ProfileStore,
    private readonly dekByVersion: ReadonlyMap<number, Buffer>,
    private readonly currentDekVersion: number,
    private readonly logger: Logger,
    private readonly opts: LifecycleOptions = {},
  ) {}

  /** Acquires the profile lock and decrypts the stored blob if any. */
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
      const data = await this.loadProfileData(profileId);
      return { profileId, lockToken, readOnly: false, ...data };
    } catch (err) {
      await this.store.unlock(profileId, lockToken).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Loads a profile WITHOUT taking the lock, for a read-only session: many
   * sessions can share one profile at once (no serialization) and nothing is
   * saved back. `release`/`commit` are no-ops for a read-only acquire.
   */
  async acquireReadOnly(profileId: string): Promise<AcquiredProfile> {
    if (!PROFILE_ID_REGEX.test(profileId)) {
      throw new LifecycleError("INVALID_ID", `invalid profile id: "${profileId}"`);
    }
    const data = await this.loadProfileData(profileId);
    return { profileId, lockToken: null, readOnly: true, ...data };
  }

  private async loadProfileData(profileId: string): Promise<{
    cookies: CdpCookie[];
    storage: Record<string, OriginStorage>;
    indexeddb: BrowserserveFile[];
    isExisting: boolean;
  }> {
    const blob = await this.store.getRaw(profileId);
    if (!blob) {
      return { cookies: [], storage: {}, indexeddb: [], isExisting: false };
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
    const indexeddb = Array.isArray(parsed.indexeddb) ? parsed.indexeddb : [];
    return { cookies, storage, indexeddb, isExisting: true };
  }

  /**
   * Injects cookies plus eager top-K localStorage; deferred origins are returned to the caller.
   *
   * If `client` is provided, the inject reuses that already-connected WS so the caller can
   * also pass it to the background phase and to commit() — one WS for the whole session.
   * Without `client`, a transient WS is opened and closed for this call only.
   */
  async inject(
    acquired: AcquiredProfile,
    providerWsUrl: string,
    client?: WsCDPClient,
  ): Promise<{ injected: number; originsInjected: string[]; originsDeferred: string[] }> {
    const cdpTimeoutMs = this.opts.cdpTimeoutMs ?? 10_000;
    const eagerOriginLimit = this.opts.eagerOriginLimit ?? 20;
    const helperPages = this.opts.helperPages ?? 4;

    const profile: CapturedProfile = {
      version: PROFILE_VERSION,
      capturedAt: new Date().toISOString(),
      cookies: acquired.cookies,
      storage: acquired.storage,
      meta: { capturedOrigins: [], skippedOrigins: [], durationMs: 0 },
    };

    let result;
    try {
      result = client
        ? await injectStateEager(client, profile, { eagerOriginLimit, helperPages })
        : await injectStateEagerViaTransient(providerWsUrl, profile, {
            eagerOriginLimit,
            helperPages,
            totalTimeoutMs: cdpTimeoutMs,
          });
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
   * Captures latest state, encrypts, persists, and releases the lock. Errors are swallowed.
   *
   * If `client` is provided, capture reuses that already-connected WS — pair this with
   * inject(acquired, url, client) and the background phase so the entire profile session
   * runs on one WS connection per provider.
   */
  async commit(acquired: AcquiredProfile, providerWsUrl: string, client?: WsCDPClient): Promise<void> {
    const promise = this.runCommit(acquired, providerWsUrl, client);
    this.pendingCommits.add(promise);
    promise.finally(() => this.pendingCommits.delete(promise));
    return promise;
  }

  /** Encrypts a profile with the current DEK and writes it to the store. No-op if the DEK is missing. */
  private async encodeAndStore(
    profile: CapturedProfile,
    profileId: string,
    logMessage: string,
    extraLogFields: Record<string, unknown>,
  ): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(profile), "utf-8");
    const dek = this.dekByVersion.get(this.currentDekVersion);
    if (!dek) {
      this.logger.error(
        { profileId, dekVersion: this.currentDekVersion },
        "profile lifecycle: current DEK missing, skipping save",
      );
      return;
    }
    const { bytes } = encodeBlob(dek, this.currentDekVersion, plaintext, profileId);
    await this.store.putRaw(profileId, bytes);
    this.logger.info({ profileId, bytes: bytes.length, ...extraLogFields }, logMessage);
  }

  private async runCommit(acquired: AcquiredProfile, providerWsUrl: string, client?: WsCDPClient): Promise<void> {
    const commitTimeoutMs = this.opts.commitTimeoutMs ?? this.opts.cdpTimeoutMs ?? 10_000;
    const helperPages = this.opts.helperPages ?? 4;

    try {
      const captureResult = client
        ? await captureFullStateOnClient(
            client,
            Object.keys(acquired.storage),
            { helperPages, includeCookieDerivedOrigins: true },
          )
        : await captureFullStateViaTransient(
            providerWsUrl,
            Object.keys(acquired.storage),
            { helperPages, totalTimeoutMs: commitTimeoutMs, includeCookieDerivedOrigins: true },
          );

      const cookies = captureResult.cookies;

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

      const mergedStorage: Record<string, OriginStorage> = { ...acquired.storage };
      for (const [origin, data] of Object.entries(captureResult.storage)) {
        mergedStorage[origin] = data;
      }

      const profile: CapturedProfile = {
        version: PROFILE_VERSION,
        capturedAt: new Date().toISOString(),
        cookies,
        storage: mergedStorage,
        indexeddb: acquired.indexeddb,
        meta: {
          capturedOrigins: Object.keys(captureResult.storage),
          skippedOrigins: captureResult.skippedOrigins,
          durationMs: captureResult.durationMs,
        },
      };

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

      const finalProfile: CapturedProfile = { ...enforced.profile, indexeddb: profile.indexeddb };
      await this.encodeAndStore(finalProfile, acquired.profileId, "profile lifecycle: state saved", {
        cookies: cookies.length,
      });
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

  /** Awaits all in-flight commits, up to `timeoutMs`. Logs WARN on timeout. */
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

  /** Returns the number of in-flight commits. */
  pendingCommitCount(): number {
    return this.pendingCommits.size;
  }

  /** Returns true once `drain()` has been called. */
  isDraining(): boolean {
    return this.draining;
  }

  /** Releases the lock without persisting. */
  /**
   * Stores a profile captured by a browserserve provider (via the channel),
   * then releases the lock. Unlike {@link commit}, capture already happened
   * remotely, so there is no CDP work here. Preserves previous state if the
   * capture came back empty. Always releases the lock.
   */
  async commitCaptured(
    acquired: AcquiredProfile,
    captured: { cookies: CdpCookie[]; storage: Record<string, OriginStorage>; indexeddb: BrowserserveFile[] },
  ): Promise<void> {
    try {
      const cookies = captured.cookies;
      if (cookies.length === 0 && acquired.cookies.length > 0) {
        this.logger.warn(
          { profileId: acquired.profileId, previousCookies: acquired.cookies.length },
          "browserserve capture returned 0 cookies — preserving previous state, not overwriting",
        );
        return;
      }
      const mergedStorage: Record<string, OriginStorage> = { ...acquired.storage };
      for (const [origin, data] of Object.entries(captured.storage)) {
        mergedStorage[origin] = data;
      }
      const profile: CapturedProfile = {
        version: PROFILE_VERSION,
        capturedAt: new Date().toISOString(),
        cookies,
        storage: mergedStorage,
        indexeddb: captured.indexeddb.length > 0 ? captured.indexeddb : acquired.indexeddb,
        meta: { capturedOrigins: Object.keys(captured.storage), skippedOrigins: [], durationMs: 0 },
      };
      const enforced = enforceProfileLimits(profile, this.opts.limits);
      if (enforced.refused) {
        this.logger.warn(
          { profileId: acquired.profileId, bytes: enforced.bytes, reason: enforced.refusedReason },
          "browserserve profile refused to save — previous state preserved",
        );
        return;
      }
      const finalProfile: CapturedProfile = { ...enforced.profile, indexeddb: profile.indexeddb };
      await this.encodeAndStore(finalProfile, acquired.profileId, "browserserve profile state saved", {
        cookies: cookies.length,
        indexeddbFiles: profile.indexeddb?.length ?? 0,
      });
    } catch (err) {
      this.logger.warn(
        { profileId: acquired.profileId, error: err instanceof Error ? err.message : String(err) },
        "browserserve commit failed, previous state preserved",
      );
    } finally {
      await this.release(acquired);
    }
  }

  async release(acquired: AcquiredProfile): Promise<void> {
    if (acquired.readOnly || !acquired.lockToken) {
      return; // read-only acquire held no lock
    }
    await this.store.unlock(acquired.profileId, acquired.lockToken).catch((err) => {
      this.logger.warn(
        { profileId: acquired.profileId, error: err instanceof Error ? err.message : String(err) },
        "profile lifecycle: unlock failed (will recover via stale TTL)",
      );
    });
  }
}
