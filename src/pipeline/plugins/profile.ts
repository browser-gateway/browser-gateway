import {
  PROFILE_ID_REGEX,
  PROFILE_VERSION,
  captureFullStateOnClient,
  injectStateEager,
  type CapturedProfile,
  type ProfileLimits,
} from "../../core/profile/index.js";
import { mergeAndPrepareProfile } from "../../core/profile/save.js";
import type { CdpMessage, CdpPlugin, SessionState } from "../types.js";
import { PluginCdpClient } from "./profile-cdp-client.js";
import type { LockToken, ProfileStorage } from "./profile-storage.js";

/** Caller-owned lifecycle. When set, the plugin skips its own load/lock
 *  and uses the provided decrypted profile. `onSave` is called with the
 *  captured profile on session end (unless the empty-capture / limits
 *  guards fire); the caller is responsible for release. */
export interface ProfilePluginPreloaded {
  profile: CapturedProfile;
  onSave?: (captured: CapturedProfile) => Promise<void>;
  onEmptyCapture?: () => Promise<void>;
}

export interface ProfilePluginOpts {
  /** Profile identifier. Validated against {@link PROFILE_ID_REGEX}. */
  profileId: string;
  /** Storage adapter. Required unless {@link preloaded} is set. */
  storage?: ProfileStorage;
  /** Caller-owned lifecycle. Skips the plugin's own acquire/load. */
  preloaded?: ProfilePluginPreloaded;
  /** If true, no lock is taken and no state is written back on session end. */
  readOnly?: boolean;
  /** Top-K origins to inject eagerly. Default 20. */
  eagerOriginLimit?: number;
  /** Number of helper pages the inject/capture pool opens. Default 4. */
  helperPages?: number;
  /** Size limits enforced on commit. See `enforceProfileLimits`. */
  limits?: ProfileLimits;
  /** Lock TTL (ms). Default 5 min. */
  lockTtlMs?: number;
  /** Per-CDP-command budget for inject (ms). Default 10_000. */
  cdpTimeoutMs?: number;
  /** Called on non-fatal issues. */
  logger?: (msg: string, data?: Record<string, unknown>) => void;
}

export type ProfilePluginFailureReason =
  | "INVALID_ID"
  | "LOCK_HELD"
  | "DECRYPT_FAILED"
  | "INJECT_FAILED"
  | "UNKNOWN_DEK_VERSION";

export class ProfilePluginError extends Error {
  constructor(
    public readonly reason: ProfilePluginFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "ProfilePluginError";
  }
}

/** Injects a captured profile at session start; captures + persists at
 *  session end. Runs on the same CDP connection the client uses — no
 *  second WebSocket, works uniformly across cloud providers where the old
 *  bookend model failed silently. */
export class ProfilePlugin implements CdpPlugin {
  readonly name = "profile";

  private client: PluginCdpClient | null = null;
  private lockToken: LockToken | null = null;
  private loadedProfile: CapturedProfile | null = null;
  private isExisting = false;
  private started = false;

  constructor(private readonly opts: ProfilePluginOpts) {
    if (!PROFILE_ID_REGEX.test(opts.profileId)) {
      throw new ProfilePluginError("INVALID_ID", `invalid profile id: "${opts.profileId}"`);
    }
    if (!opts.storage && !opts.preloaded) {
      throw new ProfilePluginError(
        "INVALID_ID",
        "ProfilePlugin needs either `storage` or `preloaded`",
      );
    }
  }

  async onSessionStart(state: SessionState): Promise<void> {
    const lockTtlMs = this.opts.lockTtlMs ?? 5 * 60_000;
    const eagerOriginLimit = this.opts.eagerOriginLimit ?? 20;
    const helperPages = this.opts.helperPages ?? 4;

    if (this.opts.preloaded) {
      this.loadedProfile = this.opts.preloaded.profile;
      this.isExisting = true;
    } else {
      if (!this.opts.readOnly) {
        this.lockToken = await this.opts.storage!.acquireLock(this.opts.profileId, lockTtlMs);
        if (!this.lockToken) {
          throw new ProfilePluginError(
            "LOCK_HELD",
            `profile "${this.opts.profileId}" is in use by another session`,
          );
        }
      }
      try {
        const loaded = await this.opts.storage!.load(this.opts.profileId);
        this.loadedProfile = loaded?.profile ?? emptyProfile();
        this.isExisting = loaded !== null;
      } catch (err) {
        await this.releaseLockSilent();
        const message = err instanceof Error ? err.message : String(err);
        const reason: ProfilePluginFailureReason = /dek version/i.test(message)
          ? "UNKNOWN_DEK_VERSION"
          : "DECRYPT_FAILED";
        throw new ProfilePluginError(reason, message);
      }
    }

    this.client = new PluginCdpClient(state);
    this.started = true;

    try {
      const result = await injectStateEager(this.client, this.loadedProfile, {
        eagerOriginLimit,
        helperPages,
      });
      this.opts.logger?.("profile: state injected", {
        profileId: this.opts.profileId,
        cookies: result.cookiesSet,
        originsInjected: result.originsInjected.length,
        originsDeferred: result.originsDeferred.length,
        durationMs: result.durationMs,
      });
    } catch (err) {
      await this.releaseLockSilent();
      throw new ProfilePluginError(
        "INJECT_FAILED",
        `state inject failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  onEvent(msg: CdpMessage): void {
    if (!this.started || !this.client) return;
    this.client.dispatchEvent(msg);
  }

  async onSessionEnd(_state: SessionState, _reason: string): Promise<void> {
    if (!this.started || !this.client) return;
    // Read-only + preloaded (no onSave) OR no lock + no preloaded save →
    // no state to write back.
    const willSave = this.opts.preloaded?.onSave ?? (!this.opts.readOnly && this.lockToken);
    if (!willSave || !this.loadedProfile) {
      await this.releaseLockSilent();
      return;
    }

    const helperPages = this.opts.helperPages ?? 4;
    let saved = false;

    try {
      const captureResult = await captureFullStateOnClient(
        this.client,
        Object.keys(this.loadedProfile.storage),
        { helperPages, includeCookieDerivedOrigins: true },
      );

      const prepared = mergeAndPrepareProfile({
        loadedStorage: this.loadedProfile.storage,
        loadedCookies: this.loadedProfile.cookies,
        loadedIndexeddb: this.loadedProfile.indexeddb,
        capturedCookies: captureResult.cookies,
        capturedStorage: captureResult.storage,
        capturedSkippedOrigins: captureResult.skippedOrigins,
        capturedDurationMs: captureResult.durationMs,
        limits: this.opts.limits,
      });

      if (prepared.action === "preserved-empty-capture") {
        this.opts.logger?.("profile: 0 cookies captured but previous had — preserved", {
          profileId: this.opts.profileId,
          previousCookies: this.loadedProfile.cookies.length,
        });
      } else if (prepared.action === "preserved-refused") {
        this.opts.logger?.("profile: refused to save — previous preserved", {
          profileId: this.opts.profileId,
          bytes: prepared.bytes,
          reason: prepared.refusedReason,
        });
      } else {
        if (prepared.evictedOrigins && prepared.evictedOrigins.length > 0) {
          this.opts.logger?.("profile: evicted oldest origins to fit budget", {
            profileId: this.opts.profileId,
            evicted: prepared.evictedOrigins.length,
            bytes: prepared.bytes,
          });
        }
        if (prepared.softWarn) {
          this.opts.logger?.("profile: profile exceeds soft-warn threshold", {
            profileId: this.opts.profileId,
            bytes: prepared.bytes,
          });
        }
        if (this.opts.preloaded?.onSave) {
          await this.opts.preloaded.onSave(prepared.profile!);
        } else {
          await this.opts.storage!.save(this.opts.profileId, prepared.profile!);
        }
        saved = true;
      }
    } catch (err) {
      this.opts.logger?.("profile: capture/save failed — previous preserved", {
        profileId: this.opts.profileId,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (!saved && this.opts.preloaded?.onEmptyCapture) {
        try { await this.opts.preloaded.onEmptyCapture(); } catch { /* tolerated */ }
      }
      await this.releaseLockSilent();
    }
  }

  private async releaseLockSilent(): Promise<void> {
    // Preloaded mode — the caller owns the lock.
    if (this.opts.preloaded || !this.lockToken || !this.opts.storage) return;
    const token = this.lockToken;
    this.lockToken = null;
    try {
      await this.opts.storage.releaseLock(this.opts.profileId, token);
    } catch {
      /* tolerated — stale TTL will reclaim */
    }
  }

  /** Test/introspection hook. */
  wasExisting(): boolean {
    return this.isExisting;
  }
}

function emptyProfile(): CapturedProfile {
  return {
    version: PROFILE_VERSION,
    capturedAt: new Date().toISOString(),
    cookies: [],
    storage: {},
    meta: { capturedOrigins: [], skippedOrigins: [], durationMs: 0 },
  };
}
