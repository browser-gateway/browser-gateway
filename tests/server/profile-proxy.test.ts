import { describe, expect, it, vi } from "vitest";
import { applySessionDefaultsForUrl, profileProxyFor, profilesUsingProxy } from "../../src/server/profile/profile-proxy.js";
import type { GatewayConfig } from "../../src/core/types.js";
import type { ProfileStore } from "../../src/core/profile/store.js";

const config = {
  proxies: { home: { url: "http://127.0.0.1:8080" } },
  sessionDefaults: { record: false, profile: null, saveProfile: false, proxy: null },
} as unknown as GatewayConfig;

function store(settings: Record<string, string | null>): ProfileStore {
  return {
    getRaw: async () => null,
    putRaw: async () => undefined,
    delete: async () => undefined,
    list: async () => Object.keys(settings).map((id) => ({ id, updatedAt: "", sizeBytes: 0, dekVersion: 1 })),
    lock: async () => "t",
    unlock: async () => undefined,
    getSettings: async (id) => (id in settings ? { proxy: settings[id] ?? null } : null),
  };
}

describe("profile proxy on the server", () => {
  it("uses a profile's saved proxy and ignores one that no longer exists, with a warning", async () => {
    const warn = vi.fn();
    const logger = { warn } as never;
    expect(await profileProxyFor(store({ a: "home" }), config, "a", logger)).toBe("home");
    expect(await profileProxyFor(store({ b: "gone" }), config, "b", logger)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(await profileProxyFor(store({}), config, null, logger)).toBeNull();
  });

  it("does not read profile settings when the url already names a proxy or no profile", async () => {
    const s = store({ a: "home" });
    const spy = vi.spyOn(s, "getSettings");
    await applySessionDefaultsForUrl(new URL("ws://g/v1/connect?profile=a&proxy=none"), config, s);
    await applySessionDefaultsForUrl(new URL("ws://g/v1/connect"), config, s);
    expect(spy).not.toHaveBeenCalled();
    const url = await applySessionDefaultsForUrl(new URL("ws://g/v1/connect?profile=a"), config, s);
    expect(url.searchParams.get("proxy")).toBe("home");
  });

  it("lists the profiles that keep a proxy", async () => {
    expect(await profilesUsingProxy(store({ a: "home", b: null, c: "home" }), "home")).toEqual(["a", "c"]);
  });
});
