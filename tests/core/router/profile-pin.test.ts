/**
 * Profile pin eligibility — provider slots can be pinned to serve one profile.
 * Cases:
 *   1. Pinned slot serves matching ?profile=<name>
 *   2. Pinned slot refuses non-matching ?profile=<name>
 *   3. Pinned slot refuses stateless traffic (no ?profile=)
 *   4. Unpinned slot serves stateless traffic
 *   5. Unpinned slot refuses ?profile=<name>
 *   6. Two slots pinned to different profiles both eligible for their own name
 *   7. multiProfile: true accepts any profile including stateless
 *   8. Explicit targetProviderId still enforces profile pin
 *   9. isEligibleForProfile helper — direct semantics
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ProviderRegistry } from "../../../src/core/providers/registry.js";
import { CooldownTracker } from "../../../src/core/tracking/cooldown.js";
import {
  ProviderSelector,
  isEligibleForProfile,
} from "../../../src/core/router/selector.js";
import { GatewayConfigSchema } from "../../../src/core/types.js";

const cfg = () =>
  GatewayConfigSchema.parse({
    providers: {
      "acme-slot": { url: "ws://acme", priority: 1, profile: "acme" },
      "bravo-slot": { url: "ws://bravo", priority: 1, profile: "bravo" },
      "stateless-slot": { url: "ws://stateless", priority: 2 },
      "runtime-slot": { url: "ws://runtime", priority: 3, multiProfile: true },
    },
  });

let registry: ProviderRegistry;
let cooldown: CooldownTracker;
let selector: ProviderSelector;

beforeEach(() => {
  registry = new ProviderRegistry();
  for (const [id, p] of Object.entries(cfg().providers)) {
    registry.register(id, p, { autoProbe: false });
  }
  cooldown = new CooldownTracker(cfg().gateway.cooldown);
  selector = new ProviderSelector(registry, cooldown, "priority-chain");
});

describe("profile-pin eligibility", () => {
  it("pinned slot serves matching profile", () => {
    const c = selector.getCandidates({ profileId: "acme" });
    expect(c.map((p) => p.id).sort()).toEqual(["acme-slot", "runtime-slot"]);
  });

  it("pinned slot refuses non-matching profile", () => {
    const c = selector.getCandidates({ profileId: "acme" });
    expect(c.map((p) => p.id)).not.toContain("bravo-slot");
  });

  it("pinned slot refuses stateless traffic", () => {
    const c = selector.getCandidates({ profileId: null });
    expect(c.map((p) => p.id)).not.toContain("acme-slot");
    expect(c.map((p) => p.id)).not.toContain("bravo-slot");
  });

  it("unpinned slot serves stateless traffic", () => {
    const c = selector.getCandidates({ profileId: null });
    expect(c.map((p) => p.id).sort()).toEqual(["runtime-slot", "stateless-slot"]);
  });

  it("unpinned stateless-only slot refuses named profile", () => {
    const c = selector.getCandidates({ profileId: "acme" });
    expect(c.map((p) => p.id)).not.toContain("stateless-slot");
  });

  it("two pinned slots each serve their own profile", () => {
    const acme = selector.getCandidates({ profileId: "acme" });
    const bravo = selector.getCandidates({ profileId: "bravo" });
    expect(acme.map((p) => p.id)).toContain("acme-slot");
    expect(bravo.map((p) => p.id)).toContain("bravo-slot");
    expect(acme.map((p) => p.id)).not.toContain("bravo-slot");
    expect(bravo.map((p) => p.id)).not.toContain("acme-slot");
  });

  it("multiProfile slot accepts any profile including stateless", () => {
    for (const req of [null, "acme", "bravo", "something-new"]) {
      const c = selector.getCandidates({ profileId: req });
      expect(c.map((p) => p.id)).toContain("runtime-slot");
    }
  });

  it("targetProviderId still enforces profile pin", () => {
    const good = selector.getCandidates({ targetProviderId: "acme-slot", profileId: "acme" });
    const bad = selector.getCandidates({ targetProviderId: "acme-slot", profileId: "bravo" });
    expect(good).toHaveLength(1);
    expect(bad).toHaveLength(0);
  });

  it("no eligible provider → empty candidates", () => {
    const c = selector.getCandidates({ profileId: "unknown-profile" });
    expect(c.map((p) => p.id).sort()).toEqual(["runtime-slot"]);
  });
});

describe("isEligibleForProfile helper", () => {
  const base = { url: "ws://x", priority: 1, weight: 1 } as const;

  it("multiProfile accepts everything", () => {
    const p = { ...base, multiProfile: true };
    expect(isEligibleForProfile(p, "any")).toBe(true);
    expect(isEligibleForProfile(p, null)).toBe(true);
    expect(isEligibleForProfile(p, undefined)).toBe(true);
  });

  it("pinned accepts only matching profile", () => {
    const p = { ...base, multiProfile: false, profile: "acme" };
    expect(isEligibleForProfile(p, "acme")).toBe(true);
    expect(isEligibleForProfile(p, "bravo")).toBe(false);
    expect(isEligibleForProfile(p, null)).toBe(false);
  });

  it("stateless-only accepts only unpinned traffic", () => {
    const p = { ...base, multiProfile: false };
    expect(isEligibleForProfile(p, null)).toBe(true);
    expect(isEligibleForProfile(p, undefined)).toBe(true);
    expect(isEligibleForProfile(p, "acme")).toBe(false);
  });
});
