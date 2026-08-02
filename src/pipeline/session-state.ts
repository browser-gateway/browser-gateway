import type { CdpMessage, SessionState, TargetInfo } from "./types.js";

/** Concrete implementation of the SessionState interface. The pipeline
 *  updates the mutable Map/state fields as CDP framework messages flow;
 *  plugins read via the SessionState interface which exposes ReadonlyMap. */
export class SessionStateImpl implements SessionState {
  readonly upstreamUrl: string;
  readonly targets = new Map<string, TargetInfo>();
  sendInternal!: <T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<T>;
  sendInternalOneWay!: (method: string, params?: Record<string, unknown>, sessionId?: string) => void;

  constructor(upstreamUrl: string) {
    this.upstreamUrl = upstreamUrl;
  }

  /** Update state based on a client → upstream command. Cheap state-machine
   *  updates only; returns quickly. */
  applyClientCommand(_msg: CdpMessage): void {
    // v0.1: no client-side state updates needed. Placeholder for future
    // features (e.g., tracking Page.enable per-session for a plugin that
    // needs to know if the client already enabled the domain).
  }

  /** Update state based on an upstream → client event. */
  applyUpstreamEvent(msg: CdpMessage): void {
    if (msg.method === "Target.attachedToTarget") {
      const p = msg.params as { sessionId?: string; targetInfo?: { targetId?: string; type?: string; url?: string } } | undefined;
      if (p?.sessionId && p.targetInfo?.targetId) {
        this.targets.set(p.sessionId, {
          targetId: p.targetInfo.targetId,
          type: normalizeType(p.targetInfo.type),
          url: p.targetInfo.url,
        });
      }
    } else if (msg.method === "Target.detachedFromTarget") {
      const p = msg.params as { sessionId?: string } | undefined;
      if (p?.sessionId) this.targets.delete(p.sessionId);
    }
  }
}

function normalizeType(t: string | undefined): TargetInfo["type"] {
  if (t === "page" || t === "iframe" || t === "worker" || t === "browser") return t;
  return "other";
}
