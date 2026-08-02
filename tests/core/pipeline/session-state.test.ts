import { describe, it, expect } from "vitest";
import { SessionStateImpl } from "../../../src/pipeline/session-state.js";

describe("SessionStateImpl", () => {
  it("tracks Target.attachedToTarget", () => {
    const s = new SessionStateImpl("wss://upstream/");
    s.applyUpstreamEvent({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "abc",
        targetInfo: { targetId: "T1", type: "page", url: "https://example.com" },
      },
    });
    expect(s.targets.get("abc")).toEqual({ targetId: "T1", type: "page", url: "https://example.com" });
  });

  it("removes on Target.detachedFromTarget", () => {
    const s = new SessionStateImpl("wss://upstream/");
    s.applyUpstreamEvent({
      method: "Target.attachedToTarget",
      params: { sessionId: "abc", targetInfo: { targetId: "T1", type: "page" } },
    });
    s.applyUpstreamEvent({ method: "Target.detachedFromTarget", params: { sessionId: "abc" } });
    expect(s.targets.has("abc")).toBe(false);
  });

  it("normalizes unknown target type to 'other'", () => {
    const s = new SessionStateImpl("wss://upstream/");
    s.applyUpstreamEvent({
      method: "Target.attachedToTarget",
      params: { sessionId: "x", targetInfo: { targetId: "T", type: "service_worker" } },
    });
    expect(s.targets.get("x")?.type).toBe("other");
  });

  it("ignores unrelated events", () => {
    const s = new SessionStateImpl("wss://upstream/");
    s.applyUpstreamEvent({ method: "Page.frameNavigated", params: {} });
    expect(s.targets.size).toBe(0);
  });

  it("ignores malformed Target events", () => {
    const s = new SessionStateImpl("wss://upstream/");
    s.applyUpstreamEvent({ method: "Target.attachedToTarget", params: undefined });
    s.applyUpstreamEvent({ method: "Target.attachedToTarget", params: { sessionId: "x" } });
    s.applyUpstreamEvent({ method: "Target.attachedToTarget", params: { targetInfo: { targetId: "T" } } });
    expect(s.targets.size).toBe(0);
  });
});
