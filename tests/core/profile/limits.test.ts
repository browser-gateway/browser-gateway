/**
 * Tests for profile size limits + LRU origin eviction.
 *
 * Pins:
 *   - profiles under softWarnBytes: no warning, no eviction
 *   - profiles between soft and hard: warn flag set, no eviction
 *   - profiles above hardCapBytes with many origins: oldest origins evicted
 *   - profiles above hardCapBytes with NO origins (huge cookie jar): refused
 *   - maxOrigins cap: drops oldest by lastVisitedAt
 *   - origins missing lastVisitedAt: treated as oldest
 */
import { describe, expect, it } from "vitest";
import { enforceProfileLimits, DEFAULT_PROFILE_LIMITS } from "../../../src/core/profile/limits.js";
import type { CapturedProfile, OriginStorage, CdpCookie } from "../../../src/core/profile/index.js";

function makeProfile(opts: {
  cookies?: CdpCookie[];
  origins?: Array<{ url: string; lastVisitedAt?: string; localStorage?: Record<string, string> }>;
}): CapturedProfile {
  const storage: Record<string, OriginStorage> = {};
  for (const o of opts.origins ?? []) {
    storage[o.url] = {
      localStorage: o.localStorage ?? { k: "v" },
      sessionStorage: {},
      lastVisitedAt: o.lastVisitedAt,
    };
  }
  return {
    version: 1,
    capturedAt: "2026-06-23T00:00:00Z",
    cookies: opts.cookies ?? [],
    storage,
    meta: { capturedOrigins: [], skippedOrigins: [], durationMs: 0 },
  };
}

function makeBigCookie(sizeBytes: number): CdpCookie {
  return {
    name: "fat",
    value: "x".repeat(Math.max(1, sizeBytes - 50)),
    domain: ".example.com",
    path: "/",
    secure: false,
    httpOnly: false,
  };
}

describe("enforceProfileLimits — happy paths", () => {
  it("small profile: no warn, no eviction, not refused", () => {
    const r = enforceProfileLimits(makeProfile({
      cookies: [{ name: "c", value: "v", domain: ".x", path: "/", secure: false, httpOnly: false }],
      origins: [{ url: "https://a.com" }],
    }));
    expect(r.softWarn).toBe(false);
    expect(r.refused).toBe(false);
    expect(r.evictedOrigins).toEqual([]);
    expect(r.bytes).toBeGreaterThan(0);
  });

  it("profile under softWarnBytes returns the same identity (no copy churn)", () => {
    const input = makeProfile({});
    const r = enforceProfileLimits(input);
    // We intentionally don't promise reference equality — even no-op produces a
    // copy via spread — but the storage keys should be identical.
    expect(Object.keys(r.profile.storage)).toEqual(Object.keys(input.storage));
  });
});

describe("enforceProfileLimits — soft warn threshold", () => {
  it("profile above softWarnBytes but below hardCapBytes: warn flag, no eviction", () => {
    const r = enforceProfileLimits(makeProfile({ cookies: [makeBigCookie(8_000_000)] }), {
      softWarnBytes: 5_000_000,
      hardCapBytes: 50_000_000,
    });
    expect(r.softWarn).toBe(true);
    expect(r.refused).toBe(false);
    expect(r.evictedOrigins).toEqual([]);
  });
});

describe("enforceProfileLimits — hard cap eviction", () => {
  it("evicts oldest origins by lastVisitedAt until under the cap", () => {
    const big = "y".repeat(200_000);
    const r = enforceProfileLimits(
      makeProfile({
        origins: [
          { url: "https://oldest.com", lastVisitedAt: "2026-01-01T00:00:00Z", localStorage: { k: big } },
          { url: "https://mid.com", lastVisitedAt: "2026-03-01T00:00:00Z", localStorage: { k: big } },
          { url: "https://newer.com", lastVisitedAt: "2026-05-01T00:00:00Z", localStorage: { k: big } },
          { url: "https://newest.com", lastVisitedAt: "2026-06-01T00:00:00Z", localStorage: { k: big } },
        ],
      }),
      { hardCapBytes: 500_000, softWarnBytes: 100_000 },
    );

    expect(r.refused).toBe(false);
    expect(r.evictedOrigins).toContain("https://oldest.com");
    expect(r.evictedOrigins).not.toContain("https://newest.com");
    expect(r.bytes).toBeLessThanOrEqual(500_000);
  });

  it("origins missing lastVisitedAt are evicted first (treated as oldest)", () => {
    const big = "z".repeat(200_000);
    const r = enforceProfileLimits(
      makeProfile({
        origins: [
          { url: "https://no-ts.com", localStorage: { k: big } },
          { url: "https://recent.com", lastVisitedAt: "2026-06-01T00:00:00Z", localStorage: { k: big } },
        ],
      }),
      { hardCapBytes: 300_000 },
    );
    expect(r.evictedOrigins).toContain("https://no-ts.com");
    expect(r.evictedOrigins).not.toContain("https://recent.com");
  });

  it("refuses to save when even cookie-only blob exceeds hardCapBytes", () => {
    const r = enforceProfileLimits(
      makeProfile({ cookies: [makeBigCookie(60_000_000)] }),
      { hardCapBytes: 50_000_000 },
    );
    expect(r.refused).toBe(true);
    expect(r.refusedReason).toMatch(/exceeds hardCapBytes/);
    expect(r.profile).toBeTruthy();
  });
});

describe("enforceProfileLimits — maxOrigins cap", () => {
  it("drops oldest origins above maxOrigins", () => {
    const origins = Array.from({ length: 12 }, (_, i) => ({
      url: `https://o${i}.com`,
      lastVisitedAt: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    const r = enforceProfileLimits(makeProfile({ origins }), { maxOrigins: 5 });
    expect(Object.keys(r.profile.storage).length).toBe(5);
    expect(r.evictedOrigins.length).toBe(7);
    // The 5 NEWEST should remain.
    expect(r.profile.storage["https://o11.com"]).toBeTruthy();
    expect(r.profile.storage["https://o0.com"]).toBeUndefined();
  });

  it("preserves all origins when count is under maxOrigins", () => {
    const r = enforceProfileLimits(makeProfile({
      origins: [
        { url: "https://a.com", lastVisitedAt: "2026-06-01T00:00:00Z" },
        { url: "https://b.com", lastVisitedAt: "2026-06-02T00:00:00Z" },
      ],
    }), { maxOrigins: 100 });
    expect(Object.keys(r.profile.storage).length).toBe(2);
    expect(r.evictedOrigins).toEqual([]);
  });
});

describe("enforceProfileLimits — defaults", () => {
  it("exports sensible defaults (5 MB / 50 MB / 1000 origins)", () => {
    expect(DEFAULT_PROFILE_LIMITS.softWarnBytes).toBe(5 * 1024 * 1024);
    expect(DEFAULT_PROFILE_LIMITS.hardCapBytes).toBe(50 * 1024 * 1024);
    expect(DEFAULT_PROFILE_LIMITS.maxOrigins).toBe(1000);
  });
});
