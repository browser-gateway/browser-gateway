/** CDP-aware pipeline — mux + plugin API for OSS gateway + SaaS router. */

export { Pipeline } from "./pipeline.js";
export type { PipelineSocket } from "./pipeline.js";
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
