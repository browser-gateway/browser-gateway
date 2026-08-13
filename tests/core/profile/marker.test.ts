import { describe, expect, it } from "vitest";
import {
  MARKER_DOMAIN,
  MARKER_NAME,
  MARKER_ORIGIN,
  MARKER_STORAGE_KEY,
  decodeMarker,
  encodeMarker,
  filterMarkerCookies,
  isMarkerCookie,
  isMarkerOrigin,
  stripMarkerFromStorage,
  stripMarkerOrigin,
  type ProviderMarker,
} from "../../../src/core/profile/marker.js";

describe("profile marker", () => {
  describe("encodeMarker / decodeMarker", () => {
    it("roundtrips a full marker", () => {
      const m: ProviderMarker = {
        profileId: "alpha-1",
        workspaceId: "ws_abc",
        injectedAtMs: 1_700_000_000_000,
      };
      const decoded = decodeMarker(encodeMarker(m));
      expect(decoded).toEqual(m);
    });

    it("roundtrips a marker without workspaceId", () => {
      const m: ProviderMarker = {
        profileId: "bravo-2",
        injectedAtMs: 1_700_000_001_000,
      };
      const decoded = decodeMarker(encodeMarker(m));
      expect(decoded).toEqual({ ...m, workspaceId: undefined });
    });

    it("returns null on garbage input", () => {
      expect(decodeMarker("not-base64!")).toBeNull();
      expect(decodeMarker("")).toBeNull();
      expect(decodeMarker(btoa("not json"))).toBeNull();
      expect(decodeMarker(btoa(JSON.stringify({ foo: "bar" })))).toBeNull();
      expect(decodeMarker(btoa(JSON.stringify({ profileId: 123, injectedAtMs: 1 })))).toBeNull();
      expect(decodeMarker(btoa(JSON.stringify({ profileId: "x", injectedAtMs: "not-a-number" })))).toBeNull();
    });

    it("preserves unicode profileIds", () => {
      const m: ProviderMarker = {
        profileId: "café-résumé",
        injectedAtMs: 42,
      };
      const decoded = decodeMarker(encodeMarker(m));
      expect(decoded?.profileId).toBe("café-résumé");
    });
  });

  describe("isMarkerCookie", () => {
    it("matches on the exact marker domain", () => {
      expect(isMarkerCookie({ name: MARKER_NAME, domain: MARKER_DOMAIN })).toBe(true);
    });

    it("matches when the domain carries a leading dot (Chromium normalises this)", () => {
      expect(isMarkerCookie({ name: MARKER_NAME, domain: `.${MARKER_DOMAIN}` })).toBe(true);
    });

    it("rejects marker-name on any other domain", () => {
      expect(isMarkerCookie({ name: MARKER_NAME, domain: "example.com" })).toBe(false);
      expect(isMarkerCookie({ name: MARKER_NAME, domain: `.${MARKER_DOMAIN}.evil.com` })).toBe(false);
    });

    it("rejects marker-domain with any other name", () => {
      expect(isMarkerCookie({ name: "some_other", domain: MARKER_DOMAIN })).toBe(false);
    });

    it("rejects missing domain", () => {
      expect(isMarkerCookie({ name: MARKER_NAME })).toBe(false);
    });
  });

  describe("filterMarkerCookies", () => {
    it("removes marker cookies but keeps everything else", () => {
      const cookies = [
        { name: "session", domain: ".example.com" },
        { name: MARKER_NAME, domain: MARKER_DOMAIN },
        { name: "csrf", domain: "example.com" },
        { name: MARKER_NAME, domain: `.${MARKER_DOMAIN}` },
      ];
      const filtered = filterMarkerCookies(cookies);
      expect(filtered).toHaveLength(2);
      expect(filtered.map((c) => c.name)).toEqual(["session", "csrf"]);
    });

    it("is a no-op when no markers are present", () => {
      const cookies = [
        { name: "session", domain: ".example.com" },
        { name: "csrf", domain: "example.com" },
      ];
      const filtered = filterMarkerCookies(cookies);
      expect(filtered).toHaveLength(2);
    });

    it("returns empty when input is empty", () => {
      expect(filterMarkerCookies([])).toEqual([]);
    });
  });

  describe("isMarkerOrigin", () => {
    it("matches exact origin", () => {
      expect(isMarkerOrigin(MARKER_ORIGIN)).toBe(true);
    });
    it("matches origin with trailing slash", () => {
      expect(isMarkerOrigin(`${MARKER_ORIGIN}/`)).toBe(true);
    });
    it("rejects any other origin", () => {
      expect(isMarkerOrigin("https://example.com")).toBe(false);
      expect(isMarkerOrigin(`${MARKER_ORIGIN}.evil.com`)).toBe(false);
      expect(isMarkerOrigin("")).toBe(false);
    });
  });

  describe("stripMarkerFromStorage", () => {
    it("removes the marker key but keeps everything else", () => {
      const ls = { session: "abc", [MARKER_STORAGE_KEY]: "leak", theme: "dark" };
      const out = stripMarkerFromStorage(ls);
      expect(out).toEqual({ session: "abc", theme: "dark" });
      expect(Object.keys(out)).not.toContain(MARKER_STORAGE_KEY);
    });
    it("is a no-op when no marker present", () => {
      const ls = { session: "abc", theme: "dark" };
      const out = stripMarkerFromStorage(ls);
      expect(out).toEqual({ session: "abc", theme: "dark" });
    });
  });

  describe("stripMarkerOrigin", () => {
    it("removes the whole marker-origin entry from a storage map", () => {
      const storage: Record<string, { localStorage: Record<string, string> }> = {
        "https://example.com": { localStorage: { real: "value" } },
        [MARKER_ORIGIN]: { localStorage: { [MARKER_STORAGE_KEY]: "leak" } },
        [`${MARKER_ORIGIN}/`]: { localStorage: { [MARKER_STORAGE_KEY]: "leak2" } },
      };
      const out = stripMarkerOrigin(storage);
      expect(Object.keys(out)).toEqual(["https://example.com"]);
    });
    it("is a no-op when no marker origin present", () => {
      const storage: Record<string, { localStorage: Record<string, string> }> = {
        "https://example.com": { localStorage: { real: "value" } },
      };
      const out = stripMarkerOrigin(storage);
      expect(Object.keys(out)).toEqual(["https://example.com"]);
    });
  });
});
