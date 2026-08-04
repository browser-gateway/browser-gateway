import type { Logger } from "pino";
import { ProfilePlugin } from "../../pipeline/plugins/profile.js";
import { PROFILE_VERSION } from "../../core/profile/index.js";
import type { AcquiredProfile, ProfileLifecycle } from "./lifecycle.js";

/** Wraps an already-acquired profile as a preloaded {@link ProfilePlugin}.
 *  The caller owns the lock lifecycle via {@link ProfileLifecycle}; the
 *  plugin handles inject + capture on the pipeline's CDP connection. */
export function makeProfilePluginFromAcquired(
  acquired: AcquiredProfile,
  profileLifecycle: ProfileLifecycle,
  logger: Logger,
): ProfilePlugin {
  const loadedProfile = {
    version: PROFILE_VERSION,
    capturedAt: new Date().toISOString(),
    cookies: acquired.cookies,
    storage: acquired.storage,
    indexeddb: acquired.indexeddb,
    meta: { capturedOrigins: [], skippedOrigins: [], durationMs: 0 },
  };

  return new ProfilePlugin({
    profileId: acquired.profileId,
    readOnly: acquired.readOnly,
    preloaded: acquired.readOnly
      ? { profile: loadedProfile }
      : {
          profile: loadedProfile,
          onSave: async (captured) => {
            await profileLifecycle.commitCaptured(acquired, {
              cookies: captured.cookies,
              storage: captured.storage,
              indexeddb: captured.indexeddb ?? [],
            });
          },
          onEmptyCapture: async () => {
            await profileLifecycle.release(acquired);
          },
        },
    logger: (msg, data) => logger.info(data ?? {}, msg),
  });
}
