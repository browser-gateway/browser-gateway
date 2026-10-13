import { describe, expect, it } from "vitest";
import { AgentSession } from "../../src/agent-tools/session.js";

describe("window size read-back", () => {
  it("tells the agent when the provider kept its own window size", async () => {
    const session = Object.create(AgentSession.prototype) as AgentSession;
    Object.assign(session, {
      setViewport: async () => undefined,
      viewport: async () => ({ width: 1536, height: 760, scrollX: 0, scrollY: 0, devicePixelRatio: 1 }),
    });
    const result = await session.resizeWindow({ width: 1280, height: 800 });
    expect(result).toMatchObject({ requested: { width: 1280, height: 800 }, applied: { width: 1536, height: 760 }, matched: false });
    expect(result.note).toMatch(/provider kept its own window size \(1536x760\).*not a problem with your request/);
  });

  it("keeps requests inside sane bounds", async () => {
    const session = Object.create(AgentSession.prototype) as AgentSession;
    const asked: Array<{ width: number; height: number }> = [];
    Object.assign(session, {
      setViewport: async (size: { width: number; height: number }) => void asked.push(size),
      viewport: async () => ({ width: 3840, height: 240, scrollX: 0, scrollY: 0, devicePixelRatio: 1 }),
    });
    expect((await session.resizeWindow({ width: 99_999, height: 1 })).matched).toBe(true);
    expect(asked[0]).toEqual({ width: 3840, height: 240 });
  });
});
