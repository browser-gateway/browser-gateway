import { describe, expect, it, vi } from "vitest";

const lookup = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup: (...args: unknown[]) => lookup(...args) }));

const { rejectUnsafeTargetUrl } = await import("../../src/server/rest/target-guard.js");

describe("rejectUnsafeTargetUrl", () => {
  it("rejects file: without touching DNS", async () => {
    lookup.mockReset();
    expect(await rejectUnsafeTargetUrl("file:///etc/passwd", {})).toContain("file");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects a public name that resolves to a private address", async () => {
    lookup.mockResolvedValue([{ address: "169.254.169.254" }]);
    const reason = await rejectUnsafeTargetUrl("http://metadata.example.com/latest/meta-data/", {});
    expect(reason).toContain("169.254.169.254");
  });

  it("rejects when any resolved address is private", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34" }, { address: "10.1.2.3" }]);
    expect(await rejectUnsafeTargetUrl("http://split.example.com/", {})).toContain("10.1.2.3");
  });

  it("allows a public name that resolves publicly", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
    expect(await rejectUnsafeTargetUrl("https://example.com/", {})).toBeNull();
  });

  it("skips resolution for a host the policy allows", async () => {
    lookup.mockReset();
    const reason = await rejectUnsafeTargetUrl("http://staging.internal/", {
      allowedPrivateHosts: ["staging.internal"],
    });
    expect(reason).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });
});
