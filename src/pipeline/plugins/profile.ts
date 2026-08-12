import {
  PROFILE_ID_REGEX,
  PROFILE_VERSION,
  captureCurrentOriginSnapshot,
  captureFullStateOnClient,
  injectStateEager,
  type CapturedProfile,
  type CdpCookie,
  type GetAllCookiesResponse,
  type OriginStorage,
  type ProfileLimits,
  type SkippedOrigin,
} from "../../core/profile/index.js";
import { mergeAndPrepareProfile, type MergeAndPrepareResult } from "../../core/profile/save.js";
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
  /** Number of helper pages the inject pool opens. Default 4. */
  helperPages?: number;
  /** Size limits enforced on commit. See `enforceProfileLimits`. */
  limits?: ProfileLimits;
  /** Lock TTL (ms). Default 5 min. */
  lockTtlMs?: number;
  /** Per-CDP-command budget for inject (ms). Default 10_000. */
  cdpTimeoutMs?: number;
  /** Per-origin snapshot timeout (ms). Default 5_000. */
  snapshotTimeoutMs?: number;
  /** "on-navigate" (default) snapshots each origin as the user leaves it and
   *  flushes at close. "on-close" runs the legacy walk-every-origin capture
   *  via helper pages. Use "on-close" as an emergency rollback only. */
  captureMode?: "on-navigate" | "on-close";
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

interface PageState {
  topFrameId: string | null;
  activeOrigin: string | null;
}

/** Injects a captured profile at session start; captures + persists at
 *  session end. Runs on the same CDP connection the client uses. Snapshots
 *  each visited origin's localStorage on top-frame navigation (via
 *  `Page.frameStartedLoading`) so a browser destroyed at WS close leaves
 *  nothing to reconstruct — works uniformly across cloud providers where
 *  the old post-close bookend model failed silently. */
export class ProfilePlugin implements CdpPlugin {
  readonly name = "profile";

  private client: PluginCdpClient | null = null;
  private state: SessionState | null = null;
  private lockToken: LockToken | null = null;
  private loadedProfile: CapturedProfile | null = null;
  private isExisting = false;
  private started = false;

  private readonly captureMode: "on-navigate" | "on-close";
  private readonly captureEnabled: boolean;
  private readonly snapshotTimeoutMs: number;

  private readonly pages = new Map<string, PageState>();
  private readonly originsSnapshot = new Map<string, OriginStorage>();

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
    this.captureMode = opts.captureMode ?? "on-navigate";
    this.snapshotTimeoutMs = opts.snapshotTimeoutMs ?? 5_000;
    const willSave = opts.preloaded ? Boolean(opts.preloaded.onSave) : !opts.readOnly;
    this.captureEnabled = willSave && this.captureMode === "on-navigate";
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
    this.state = state;
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

  onCommand(msg: CdpMessage): void {
    if (!this.started || !this.captureEnabled) return;
    if (msg.method !== "Page.navigate") return;
    const sessionId = msg.sessionId;
    if (!sessionId) return;
    const pageState = this.pages.get(sessionId);
    if (!pageState?.activeOrigin) return;
    const nextUrl = (msg.params as { url?: string } | undefined)?.url;
    if (typeof nextUrl !== "string" || !nextUrl.startsWith("http")) return;
    let nextOrigin: string;
    try { nextOrigin = new URL(nextUrl).origin; } catch { return; }
    if (nextOrigin === pageState.activeOrigin) return;
    const expectedOrigin = pageState.activeOrigin;
    const client = this.client;
    if (!client) return;
    void this.snapshotAndStash(client, sessionId, expectedOrigin);
  }

  private async snapshotAndStash(
    client: PluginCdpClient,
    sessionId: string,
    expectedOrigin: string,
  ): Promise<void> {
    const snap = await captureCurrentOriginSnapshot(client, sessionId, this.snapshotTimeoutMs);
    if (!snap || snap.origin !== expectedOrigin) return;
    this.originsSnapshot.set(snap.origin, {
      localStorage: snap.localStorage,
      sessionStorage: {},
      lastVisitedAt: new Date().toISOString(),
    });
  }

  onEvent(msg: CdpMessage): void {
    if (!this.started || !this.client) return;
    this.client.dispatchEvent(msg);

    if (!this.captureEnabled) return;

    const method = msg.method;
    if (!method) return;

    if (method === "Target.attachedToTarget") {
      const p = msg.params as
        | { sessionId?: string; targetInfo?: { type?: string } }
        | undefined;
      if (!p?.sessionId || p.targetInfo?.type !== "page") return;
      this.pages.set(p.sessionId, { topFrameId: null, activeOrigin: null });
      this.state?.sendInternalOneWay("Page.enable", {}, p.sessionId);
      return;
    }

    if (method === "Target.detachedFromTarget") {
      const p = msg.params as { sessionId?: string } | undefined;
      if (p?.sessionId) this.pages.delete(p.sessionId);
      return;
    }

    const sessionId = msg.sessionId;
    if (!sessionId) return;
    const pageState = this.pages.get(sessionId);
    if (!pageState) return;

    if (method === "Page.frameNavigated") {
      const p = msg.params as
        | { frame?: { id?: string; parentId?: string | null; url?: string } }
        | undefined;
      const frame = p?.frame;
      if (!frame?.id || frame.parentId != null) return;
      pageState.topFrameId = frame.id;
      const url = frame.url;
      if (typeof url !== "string" || !url.startsWith("http")) return;
      let originStr: string;
      try {
        originStr = new URL(url).origin;
      } catch {
        return;
      }
      pageState.activeOrigin = originStr;
      return;
    }

    // In-page (link/form) navs bypass Page.navigate; onCommand can't see
    // them. Fall back to Page.frameRequestedNavigation: fires when the
    // browser decides a client-initiated nav is coming but has NOT started
    // it yet, so the OLD execution context is still fully live.
    if (method === "Page.frameRequestedNavigation") {
      const p = msg.params as { frameId?: string; url?: string } | undefined;
      if (p?.frameId !== pageState.topFrameId) return;
      const expectedOrigin = pageState.activeOrigin;
      if (!expectedOrigin) return;
      let nextOrigin: string | null = null;
      if (typeof p.url === "string" && p.url.startsWith("http")) {
        try { nextOrigin = new URL(p.url).origin; } catch { /* fall through */ }
      }
      if (nextOrigin === expectedOrigin) return;
      const client = this.client;
      void this.snapshotAndStash(client, sessionId, expectedOrigin);
    }
  }

  async onSessionEnd(_state: SessionState, _reason: string): Promise<void> {
    if (!this.started || !this.client) return;
    const willSave = this.opts.preloaded?.onSave ?? (!this.opts.readOnly && this.lockToken);
    if (!willSave || !this.loadedProfile) {
      await this.releaseLockSilent();
      return;
    }

    let saved = false;
    try {
      const prepared = this.captureMode === "on-navigate"
        ? await this.buildCapturedOnNavigate()
        : await this.buildCapturedOnClose();

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

  private async buildCapturedOnNavigate(): Promise<MergeAndPrepareResult> {
    const client = this.client!;
    const started = Date.now();

    await this.snapshotActivePages();

    let cookies: CdpCookie[] = [];
    try {
      const cookieResp = (await client.send("Storage.getCookies")) as GetAllCookiesResponse | null;
      cookies = cookieResp?.cookies ?? [];
    } catch (err) {
      this.opts.logger?.("profile: Storage.getCookies failed", {
        profileId: this.opts.profileId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    const capturedStorage: Record<string, OriginStorage> = {};
    for (const [origin, data] of this.originsSnapshot) {
      capturedStorage[origin] = data;
    }
    const skipped: SkippedOrigin[] = [];

    return mergeAndPrepareProfile({
      loadedStorage: this.loadedProfile!.storage,
      loadedCookies: this.loadedProfile!.cookies,
      loadedIndexeddb: this.loadedProfile!.indexeddb,
      capturedCookies: cookies,
      capturedStorage,
      capturedSkippedOrigins: skipped,
      capturedDurationMs: Date.now() - started,
      limits: this.opts.limits,
    });
  }

  private async buildCapturedOnClose(): Promise<MergeAndPrepareResult> {
    const helperPages = this.opts.helperPages ?? 4;
    const captureResult = await captureFullStateOnClient(
      this.client!,
      Object.keys(this.loadedProfile!.storage),
      { helperPages, includeCookieDerivedOrigins: true },
    );
    return mergeAndPrepareProfile({
      loadedStorage: this.loadedProfile!.storage,
      loadedCookies: this.loadedProfile!.cookies,
      loadedIndexeddb: this.loadedProfile!.indexeddb,
      capturedCookies: captureResult.cookies,
      capturedStorage: captureResult.storage,
      capturedSkippedOrigins: captureResult.skippedOrigins,
      capturedDurationMs: captureResult.durationMs,
      limits: this.opts.limits,
    });
  }

  private async snapshotActivePages(): Promise<void> {
    const client = this.client!;
    const tasks: Promise<void>[] = [];
    for (const [sessionId, pageState] of this.pages) {
      if (!pageState.activeOrigin) continue;
      tasks.push(this.snapshotAndStash(client, sessionId, pageState.activeOrigin));
    }
    await Promise.all(tasks);
  }

  private async releaseLockSilent(): Promise<void> {
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
