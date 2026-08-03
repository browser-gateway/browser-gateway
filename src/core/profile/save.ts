import {
  PROFILE_VERSION,
  enforceProfileLimits,
  type BrowserserveFile,
  type CapturedProfile,
  type CdpCookie,
  type OriginStorage,
  type ProfileLimits,
} from "./index.js";

/** Result of {@link mergeAndPrepareProfile}. `refused`/`preserved` mean the
 *  save should be skipped and the previous state left untouched. */
export interface MergeAndPrepareResult {
  action: "save" | "preserved-empty-capture" | "preserved-refused";
  profile?: CapturedProfile;
  refusedReason?: string;
  evictedOrigins?: string[];
  softWarn?: boolean;
  bytes?: number;
}

export interface MergeInputs {
  /** Storage from the currently-loaded blob (empty for new profiles). */
  loadedStorage: Record<string, OriginStorage>;
  /** Previously-loaded cookies (used only for the empty-capture guard). */
  loadedCookies: CdpCookie[];
  /** IndexedDB carried across if the browserserve channel provided it. */
  loadedIndexeddb?: BrowserserveFile[];
  /** Fresh capture from this session. */
  capturedCookies: CdpCookie[];
  capturedStorage: Record<string, OriginStorage>;
  capturedSkippedOrigins: { origin: string; reason: string }[];
  capturedDurationMs: number;
  /** Size limits from the caller. */
  limits?: ProfileLimits;
}

/** Runs the empty-capture guard, merges captured storage over loaded, applies
 *  size limits, and returns the encoded profile ready for {@link ProfileStorage.save}.
 *  Shared between {@link ProfilePlugin} and {@link ProfileLifecycle}. */
export function mergeAndPrepareProfile(inputs: MergeInputs): MergeAndPrepareResult {
  if (inputs.capturedCookies.length === 0 && inputs.loadedCookies.length > 0) {
    return { action: "preserved-empty-capture" };
  }

  const mergedStorage: Record<string, OriginStorage> = { ...inputs.loadedStorage };
  for (const [origin, data] of Object.entries(inputs.capturedStorage)) {
    mergedStorage[origin] = data;
  }

  const profile: CapturedProfile = {
    version: PROFILE_VERSION,
    capturedAt: new Date().toISOString(),
    cookies: inputs.capturedCookies,
    storage: mergedStorage,
    indexeddb: inputs.loadedIndexeddb,
    meta: {
      capturedOrigins: Object.keys(inputs.capturedStorage),
      skippedOrigins: inputs.capturedSkippedOrigins,
      durationMs: inputs.capturedDurationMs,
    },
  };

  const enforced = enforceProfileLimits(profile, inputs.limits);
  if (enforced.refused) {
    return {
      action: "preserved-refused",
      refusedReason: enforced.refusedReason,
      bytes: enforced.bytes,
    };
  }

  return {
    action: "save",
    profile: { ...enforced.profile, indexeddb: profile.indexeddb },
    evictedOrigins: enforced.evictedOrigins,
    softWarn: enforced.softWarn,
    bytes: enforced.bytes,
  };
}
