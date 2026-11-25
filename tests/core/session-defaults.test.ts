import { describe, expect, it } from "vitest";
import { SessionDefaultsSchema, applySessionDefaults, applySessionDefaultsWithProfileProxy, sessionProfileId, type SessionDefaults } from "../../src/core/session-defaults.js";

const OFF = SessionDefaultsSchema.parse({});
const ALL: SessionDefaults = { record: true, profile: "work", saveProfile: false, proxy: "home" };

function effective(query: string, defaults: SessionDefaults = ALL): Record<string, string> {
  return Object.fromEntries(applySessionDefaults(new URL(`ws://g/v1/connect${query}`), defaults).searchParams);
}

describe("applySessionDefaults with every default off", () => {
  it("starts with everything off", () => {
    expect(OFF).toEqual({ record: false, profile: null, saveProfile: false, proxy: null });
  });

  it.each(["", "?token=t", "?profile=p", "?profile=p&readOnly=1", "?session_record=true", "?proxy=x&provider=a", "?session_record=false&readOnly=0"])(
    "returns the very same url for %s",
    (query) => {
      const url = new URL(`ws://g/v1/connect${query}`);
      expect(applySessionDefaults(url, OFF)).toBe(url);
    },
  );
});

describe("applySessionDefaults override table", () => {
  it("fills every default into a url that says nothing", () => {
    expect(effective("?token=t")).toEqual({ token: "t", session_record: "true", profile: "work", readOnly: "1", proxy: "home" });
  });

  it("lets session_record=false turn a recording default off, and true turn it on", () => {
    expect(effective("?session_record=false").session_record).toBe("false");
    expect(effective("?session_record=true", OFF).session_record).toBe("true");
  });

  it("opens the default profile with saving when saveProfile is on", () => {
    expect(effective("", { ...ALL, saveProfile: true }).readOnly).toBe("0");
  });

  it("lets readOnly on the url override the save default both ways", () => {
    expect(effective("?readOnly=0").readOnly).toBe("0");
    expect(effective("?readOnly=1", { ...ALL, saveProfile: true }).readOnly).toBe("1");
  });

  it("keeps an explicit profile saving by default, as before", () => {
    const params = effective("?profile=other");
    expect(params.profile).toBe("other");
    expect(params.readOnly).toBeUndefined();
  });

  it("treats profile=none and proxy=none as no profile and no proxy, with or without defaults", () => {
    for (const defaults of [ALL, OFF]) {
      const params = effective("?profile=none&readOnly=0&proxy=NONE", defaults);
      expect(params.profile).toBeUndefined();
      expect(params.readOnly).toBeUndefined();
      expect(params.proxy).toBeUndefined();
    }
  });

  it("keeps an explicit proxy over the default", () => {
    expect(effective("?proxy=office").proxy).toBe("office");
  });

  it("never edits the caller's url", () => {
    const url = new URL("ws://g/v1/connect?token=t");
    applySessionDefaults(url, ALL);
    expect(url.search).toBe("?token=t");
  });
});

describe("profile proxy between the url and the default proxy", () => {
  const defaults = { record: false, profile: null, saveProfile: false, proxy: "dflt" };
  const at = (q: string) => new URL(`ws://g/v1/connect${q}`);

  it("uses the profile's proxy when the url names none, and the url's choice otherwise", () => {
    expect(applySessionDefaultsWithProfileProxy(at("?profile=p"), defaults, "pp").searchParams.get("proxy")).toBe("pp");
    expect(applySessionDefaultsWithProfileProxy(at("?profile=p&proxy=other"), defaults, "pp").searchParams.get("proxy")).toBe("other");
    expect(applySessionDefaultsWithProfileProxy(at("?profile=p&proxy=none"), defaults, "pp").searchParams.has("proxy")).toBe(false);
    expect(applySessionDefaultsWithProfileProxy(at("?profile=p"), defaults, null).searchParams.get("proxy")).toBe("dflt");
  });

  it("finds the profile a url will use, including the default profile, and none for profile=none", () => {
    expect(sessionProfileId(at("?profile=p"), defaults)).toBe("p");
    expect(sessionProfileId(at(""), { ...defaults, profile: "d" })).toBe("d");
    expect(sessionProfileId(at("?profile=none"), { ...defaults, profile: "d" })).toBeNull();
    expect(sessionProfileId(at(""), defaults)).toBeNull();
  });
});
