import { describe, expect, it, vi } from "vitest";
import { CdpProtocolClient } from "../../src/core/cdp/protocol.js";
import {
  agentInstructions,
  AgentSession,
  IDLE_MAX_MS,
  IDLE_MIN_MS,
  KEEPALIVE_DEFAULT_MS,
  LoopGuardError,
  SessionPolicy,
} from "../../src/agent-tools/index.js";

class Clock {
  private ms = 1_000_000;
  now = (): number => this.ms;
  advance(by: number): void {
    this.ms += by;
  }
}

describe("SessionPolicy", () => {
  it("clamps the idle window to the supported range", () => {
    const tiny = new SessionPolicy({ idleMs: 1_000 });
    const huge = new SessionPolicy({ idleMs: 99_000_000 });
    expect(tiny.idleMs).toBe(IDLE_MIN_MS);
    expect(huge.idleMs).toBe(IDLE_MAX_MS);
    tiny.stop();
    huge.stop();
  });

  it("never lets the keepalive drift above the routed-path cutoff", () => {
    const policy = new SessionPolicy({ keepaliveMs: 120_000 });
    expect(policy.keepaliveMs).toBe(KEEPALIVE_DEFAULT_MS);
    policy.stop();
  });

  it("reports seconds left and warns close to the idle close", () => {
    const clock = new Clock();
    const policy = new SessionPolicy({ idleMs: 300_000, now: clock.now });
    expect(policy.state().secondsUntilIdleClose).toBe(300);
    expect(policy.warning()).toBeUndefined();
    clock.advance(260_000);
    expect(policy.warning()).toContain("closes in 40s");
    policy.touch();
    expect(policy.warning()).toBeUndefined();
    policy.stop();
  });

  it("warns before the hard cap", () => {
    const clock = new Clock();
    const policy = new SessionPolicy({ hardCapMs: 90_000, now: clock.now });
    clock.advance(40_000);
    expect(policy.warning()).toContain("limit in 50s");
    policy.stop();
  });

  it("keepalive does not count as agent activity", async () => {
    vi.useFakeTimers();
    const keepalives: number[] = [];
    let expired: string | null = null;
    const policy = new SessionPolicy({
      idleMs: IDLE_MIN_MS,
      onKeepalive: () => void keepalives.push(Date.now()),
      onExpire: (reason) => void (expired = reason),
    });
    policy.start(1_000);
    await vi.advanceTimersByTimeAsync(IDLE_MIN_MS + 2_000);
    expect(keepalives.length).toBeGreaterThan(5);
    expect(expired).toBe("idle");
    policy.stop();
    vi.useRealTimers();
  });

  it("stops the session at the hard cap even while the agent is busy", async () => {
    vi.useFakeTimers();
    let expired: string | null = null;
    const policy = new SessionPolicy({ hardCapMs: 30_000, onExpire: (reason) => void (expired = reason) });
    policy.start(1_000);
    for (let i = 0; i < 40; i++) {
      policy.touch();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(expired).toBe("hard-cap");
    vi.useRealTimers();
  });

  it("stops an agent repeating the same failing action", () => {
    const policy = new SessionPolicy();
    const step = { type: "click", ref: "e1" } as const;
    policy.recordFailure(step, "is disabled");
    policy.recordFailure(step, "is disabled");
    expect(() => policy.recordFailure(step, "is disabled")).toThrow(LoopGuardError);
    policy.stop();
  });

  it("does not trip on different failures or after a success", () => {
    const policy = new SessionPolicy();
    policy.recordFailure({ type: "click", ref: "e1" }, "is disabled");
    policy.recordFailure({ type: "click", ref: "e2" }, "is disabled");
    policy.recordFailure({ type: "click", ref: "e1" }, "is disabled");
    policy.recordSuccess();
    policy.recordFailure({ type: "click", ref: "e1" }, "is disabled");
    expect(() => policy.recordFailure({ type: "click", ref: "e1" }, "is disabled")).not.toThrow();
    policy.stop();
  });
});

describe("agentInstructions", () => {
  it("states the session rules an agent must follow", () => {
    const text = agentInstructions({ idleTimeoutS: 300, hardCapHours: 4, hosted: true });
    expect(text).toContain("paid cloud session");
    expect(text).toContain("closes after 5 minutes");
    expect(text).toContain("always at 4 hours");
    expect(text).toContain("Close the browser yourself");
    expect(text).toContain("several steps in one act call");
    expect(text).toContain("Do not repeat the same failing action");
  });

  it("drops the billing wording for self-hosted use", () => {
    expect(agentInstructions()).not.toContain("paid");
  });
});

class SilentTransport {
  private onMsg: ((data: string) => void) | null = null;
  sent: string[] = [];
  send(frame: string): void {
    this.sent.push(frame);
    const msg = JSON.parse(frame) as { id: number; method: string; params: Record<string, unknown> };
    const result =
      msg.method === "Target.createTarget"
        ? { targetId: "target1" }
        : msg.method === "Target.attachToTarget"
          ? { sessionId: "cdp-1" }
          : {};
    this.onMsg?.(JSON.stringify({ id: msg.id, result }));
  }
  onMessage(cb: (data: string) => void): void {
    this.onMsg = cb;
  }
  onClose(): void {}
  async close(): Promise<void> {}
}

describe("AgentSession lifecycle", () => {
  it("closes an idle session and tells the next caller why", async () => {
    vi.useFakeTimers();
    const transport = new SilentTransport();
    const session = new AgentSession(new CdpProtocolClient(transport), {
      policy: { idleMs: IDLE_MIN_MS },
    });
    await session.openTab();
    await vi.advanceTimersByTimeAsync(IDLE_MIN_MS + 6_000);
    expect(session.expired).toBe("idle");
    await expect(session.openTab()).rejects.toThrow("closed after 1 minutes without an action");
    const keepalives = transport.sent.filter((f) => f.includes("Browser.getVersion"));
    expect(keepalives.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("exposes the session clock to callers", async () => {
    const session = new AgentSession(new CdpProtocolClient(new SilentTransport()));
    expect(session.state.idleTimeoutS).toBe(300);
    expect(session.state.secondsUntilIdleClose).toBeGreaterThan(290);
    await session.close();
  });
});
