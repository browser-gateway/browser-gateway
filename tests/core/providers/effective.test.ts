import { describe, it, expect } from "vitest";
import {
  effectiveMaxConcurrent,
  hasFreeSlot,
  isEligibleProviderForProfile,
} from "../../../src/core/providers/effective.js";
import { httpDiscoveryUrl } from "../../../src/core/providers/cdp.js";
import type { ProviderConfig, ProviderState } from "../../../src/core/types.js";

function provider(overrides: {
  maxConcurrent?: number;
  discovered?: number | null;
  detectedKind?: "browserserve" | null;
  profile?: string;
  multiProfile?: boolean;
  active?: number;
}): ProviderState {
  return {
    id: "p",
    config: {
      url: "ws://p:3000",
      priority: 1,
      limits: overrides.maxConcurrent ? { maxConcurrent: overrides.maxConcurrent } : undefined,
      profile: overrides.profile,
      multiProfile: overrides.multiProfile ?? false,
    } as ProviderConfig,
    active: overrides.active ?? 0,
    healthy: true,
    cooldownUntil: null,
    failureCount: 0,
    successCount: 0,
    lastFailure: null,
    avgLatencyMs: 0,
    totalConnections: 0,
    detectedKind: overrides.detectedKind ?? null,
    discoveredMaxConcurrent: overrides.discovered ?? null,
  };
}

describe("effectiveMaxConcurrent", () => {
  it("explicit config always wins over the discovered value", () => {
    expect(effectiveMaxConcurrent(provider({ maxConcurrent: 3, discovered: 10 }))).toBe(3);
  });

  it("adopts the discovered value when config is unset", () => {
    expect(effectiveMaxConcurrent(provider({ discovered: 6 }))).toBe(6);
  });

  it("is unlimited when neither is set", () => {
    expect(effectiveMaxConcurrent(provider({}))).toBeUndefined();
  });
});

describe("hasFreeSlot", () => {
  it("blocks at the discovered ceiling", () => {
    expect(hasFreeSlot(provider({ discovered: 2, active: 2 }))).toBe(false);
    expect(hasFreeSlot(provider({ discovered: 2, active: 1 }))).toBe(true);
  });

  it("always has a slot with no ceiling", () => {
    expect(hasFreeSlot(provider({ active: 999 }))).toBe(true);
  });
});

describe("isEligibleProviderForProfile", () => {
  it("detected browserserve serves any profile, including none", () => {
    const p = provider({ detectedKind: "browserserve" });
    expect(isEligibleProviderForProfile(p, "alpha")).toBe(true);
    expect(isEligibleProviderForProfile(p, null)).toBe(true);
  });

  it("generic providers keep the static config rules", () => {
    expect(isEligibleProviderForProfile(provider({ profile: "alpha" }), "alpha")).toBe(true);
    expect(isEligibleProviderForProfile(provider({ profile: "alpha" }), "bravo")).toBe(false);
    expect(isEligibleProviderForProfile(provider({}), "alpha")).toBe(false);
    expect(isEligibleProviderForProfile(provider({}), null)).toBe(true);
    expect(isEligibleProviderForProfile(provider({ multiProfile: true }), "bravo")).toBe(true);
  });
});

describe("httpDiscoveryUrl", () => {
  it("maps ws to http and preserves host, port, and auth query", () => {
    expect(httpDiscoveryUrl("ws://host:9222?token=abc")).toBe(
      "http://host:9222/json/version?token=abc",
    );
  });

  it("maps wss to https", () => {
    expect(httpDiscoveryUrl("wss://cloud.example.com?apiKey=k")).toBe(
      "https://cloud.example.com/json/version?apiKey=k",
    );
  });

  it("passes http through unchanged apart from the path", () => {
    expect(httpDiscoveryUrl("http://host:9222")).toBe("http://host:9222/json/version");
  });
});
