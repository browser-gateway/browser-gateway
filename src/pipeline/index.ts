/** CDP-aware pipeline — mux + plugin API for OSS gateway + SaaS router. */

export { Pipeline } from "./pipeline.js";
export type { PipelineSocket, PipelineStartResult } from "./pipeline.js";
export { InternalIdSpace } from "./id-space.js";
export { SessionStateImpl } from "./session-state.js";
export type {
  CdpMessage,
  CdpPlugin,
  SessionState,
  TargetInfo,
  PipelineOptions,
  PipelineCounters,
  PipelineResult,
  PipelineLogEvent,
} from "./types.js";
export { ScreencastCapturePlugin } from "./plugins/screencast-capture.js";
export type {
  ReplayStorage,
  ScreencastCapturePluginOpts,
} from "./plugins/screencast-capture.js";
export { ProfilePlugin, ProfilePluginError } from "./plugins/profile.js";
export type {
  ProfilePluginOpts,
  ProfilePluginPreloaded,
  ProfilePluginFailureReason,
} from "./plugins/profile.js";
export { PluginCdpClient } from "./plugins/profile-cdp-client.js";
export type { ProfileStorage, LoadedProfile, LockToken } from "./plugins/profile-storage.js";
export { ScreencastBridgePlugin } from "./plugins/screencast-bridge.js";
export type { ScreencastBridgePluginOpts } from "./plugins/screencast-bridge.js";
