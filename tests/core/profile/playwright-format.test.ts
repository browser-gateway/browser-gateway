import { describe, it, expect } from "vitest";
import {
  capturedProfileToStorageState,
  storageStateToCapturedProfile,
  PlaywrightStorageStateSchema,
} from "../../../src/core/profile/playwright-format.js";
import type { CapturedProfile } from "../../../src/core/profile/types.js";

const sampleProfile: CapturedProfile = {
  version: 1,
  capturedAt: "2026-08-29T00:00:00.000Z",
  cookies: [
    {
      name: "session",
      value: "abc123",
      domain: ".example.com",
      path: "/",
      expires: 1893456000,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
    {
      name: "ephemeral",
      value: "xyz",
      domain: "example.com",
      path: "/",
      httpOnly: false,
      secure: false,
    },
  ],
  storage: {
    "https://example.com": {
      localStorage: { theme: "dark", lang: "en" },
      sessionStorage: { transient: "1" },
    },
    "https://api.example.com": {
      localStorage: { apiKey: "prefix_abc" },
      sessionStorage: {},
    },
  },
  meta: {
    capturedOrigins: ["https://example.com", "https://api.example.com"],
    skippedOrigins: [],
    durationMs: 120,
  },
};

describe("capturedProfileToStorageState", () => {
  it("converts cookies with sameSite preserved", () => {
    const state = capturedProfileToStorageState(sampleProfile);
    expect(state.cookies).toHaveLength(2);
    expect(state.cookies[0]).toEqual({
      name: "session",
      value: "abc123",
      domain: ".example.com",
      path: "/",
      expires: 1893456000,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    });
  });

  it("emits -1 for session cookies without expires", () => {
    const state = capturedProfileToStorageState(sampleProfile);
    expect(state.cookies[1]?.expires).toBe(-1);
    expect(state.cookies[1]).not.toHaveProperty("sameSite");
  });

  it("emits origins with localStorage entries", () => {
    const state = capturedProfileToStorageState(sampleProfile);
    expect(state.origins).toHaveLength(2);
    const example = state.origins.find((o) => o.origin === "https://example.com");
    expect(example?.localStorage).toContainEqual({ name: "theme", value: "dark" });
    expect(example?.localStorage).toContainEqual({ name: "lang", value: "en" });
  });

  it("drops sessionStorage — Playwright storageState does not carry it", () => {
    const state = capturedProfileToStorageState(sampleProfile);
    const example = state.origins.find((o) => o.origin === "https://example.com");
    expect(example?.localStorage.find((e) => e.name === "transient")).toBeUndefined();
  });

  it("produces schema-valid output", () => {
    const state = capturedProfileToStorageState(sampleProfile);
    expect(() => PlaywrightStorageStateSchema.parse(state)).not.toThrow();
  });
});

describe("storageStateToCapturedProfile", () => {
  it("round-trips cookies + localStorage back to captured profile", () => {
    const state = capturedProfileToStorageState(sampleProfile);
    const back = storageStateToCapturedProfile(state);
    expect(back.cookies).toHaveLength(2);
    expect(back.cookies[0]?.name).toBe("session");
    expect(back.storage["https://example.com"]?.localStorage.theme).toBe("dark");
  });

  it("initialises sessionStorage empty on import", () => {
    const state = capturedProfileToStorageState(sampleProfile);
    const back = storageStateToCapturedProfile(state);
    expect(back.storage["https://example.com"]?.sessionStorage).toEqual({});
  });

  it("defaults sameSite to Lax when Playwright omits it", () => {
    const back = storageStateToCapturedProfile({
      cookies: [
        {
          name: "c",
          value: "v",
          domain: "example.com",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
        },
      ],
      origins: [],
    });
    expect(back.cookies[0]?.sameSite).toBe("Lax");
  });

  it("omits expires for session cookies (expires === -1)", () => {
    const back = storageStateToCapturedProfile({
      cookies: [
        {
          name: "s",
          value: "v",
          domain: "example.com",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
        },
      ],
      origins: [],
    });
    expect(back.cookies[0]).not.toHaveProperty("expires");
  });

  it("accepts an empty storage state", () => {
    const back = storageStateToCapturedProfile({ cookies: [], origins: [] });
    expect(back.cookies).toEqual([]);
    expect(back.storage).toEqual({});
    expect(back.meta.capturedOrigins).toEqual([]);
  });

  it("rejects malformed cookies", () => {
    expect(() =>
      storageStateToCapturedProfile({
        cookies: [{ name: "c" }],
        origins: [],
      }),
    ).toThrow();
  });

  it("accepts a bare cookie array (Puppeteer page.cookies + browser extensions)", () => {
    const back = storageStateToCapturedProfile([
      {
        name: "session",
        value: "abc",
        domain: ".example.com",
        path: "/",
      },
    ]);
    expect(back.cookies).toHaveLength(1);
    expect(back.cookies[0]?.name).toBe("session");
    expect(back.storage).toEqual({});
  });

  it("accepts a partial object with only cookies (no origins)", () => {
    const back = storageStateToCapturedProfile({
      cookies: [
        {
          name: "session",
          value: "abc",
          domain: ".example.com",
          path: "/",
        },
      ],
    });
    expect(back.cookies).toHaveLength(1);
    expect(back.storage).toEqual({});
  });

  it("normalises Chrome-extension expirationDate + sameSite variants", () => {
    const back = storageStateToCapturedProfile([
      {
        name: "c1",
        value: "v1",
        domain: ".example.com",
        path: "/",
        expirationDate: 1893456000,
        sameSite: "no_restriction",
      },
      {
        name: "c2",
        value: "v2",
        domain: ".example.com",
        path: "/",
        sameSite: "unspecified",
      },
      {
        name: "c3",
        value: "v3",
        domain: ".example.com",
        path: "/",
        sameSite: "lax",
      },
    ]);
    expect(back.cookies[0]?.expires).toBe(1893456000);
    expect(back.cookies[0]?.sameSite).toBe("None");
    expect(back.cookies[1]?.sameSite).toBe("Lax");
    expect(back.cookies[2]?.sameSite).toBe("Lax");
  });

  it("rejects non-URL origins", () => {
    expect(() =>
      storageStateToCapturedProfile({
        cookies: [],
        origins: [{ origin: "not-a-url", localStorage: [] }],
      }),
    ).toThrow();
  });

  it("accepts a cookie with only url (extracts domain + path)", () => {
    const back = storageStateToCapturedProfile([
      {
        name: "session",
        value: "abc",
        url: "https://example.com/app",
      },
    ]);
    expect(back.cookies[0]?.domain).toBe("example.com");
    expect(back.cookies[0]?.path).toBe("/app");
  });

  it("accepts a minimal cookie with only name + value + domain + path", () => {
    const back = storageStateToCapturedProfile([
      {
        name: "session",
        value: "v",
        domain: "example.com",
        path: "/",
      },
    ]);
    expect(back.cookies[0]?.httpOnly).toBe(false);
    expect(back.cookies[0]?.secure).toBe(false);
    expect(back.cookies[0]?.sameSite).toBe("Lax");
  });

  it("rejects a cookie with neither url nor domain+path", () => {
    expect(() =>
      storageStateToCapturedProfile([{ name: "orphan", value: "v" }]),
    ).toThrow();
  });

  it("rejects a cookie missing a value", () => {
    expect(() =>
      storageStateToCapturedProfile([
        { name: "no-value", domain: "example.com", path: "/" },
      ]),
    ).toThrow();
  });

  it("captures every origin listed in meta.capturedOrigins", () => {
    const back = storageStateToCapturedProfile({
      cookies: [],
      origins: [
        { origin: "https://a.example.com", localStorage: [{ name: "k", value: "v" }] },
        { origin: "https://b.example.com", localStorage: [] },
      ],
    });
    expect(back.meta.capturedOrigins).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });
});
