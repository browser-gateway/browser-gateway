import { describe, expect, it } from "vitest";
import { keySpecFor, modifierMask, normalizeKeyName, parseChord } from "../../src/agent-tools/keys.js";

describe("key names and chords", () => {
  it("accepts the common spellings of a key", () => {
    expect(normalizeKeyName("Return")).toBe("Enter");
    expect(normalizeKeyName("BackSpace")).toBe("Backspace");
    expect(normalizeKeyName("Page_Down")).toBe("PageDown");
    expect(normalizeKeyName("super")).toBe("Meta");
    expect(normalizeKeyName("cmd")).toBe("Meta");
    expect(normalizeKeyName("ControlOrMeta")).toBe("Control");
    expect(normalizeKeyName("f5")).toBe("F5");
    expect(normalizeKeyName("Up")).toBe("ArrowUp");
  });

  it("refuses a name it does not know rather than guessing", () => {
    expect(() => normalizeKeyName("Hyper")).toThrow(/unknown key/);
  });

  it("gives letters, digits and punctuation their physical codes", () => {
    expect(keySpecFor("a")).toMatchObject({ code: "KeyA", keyCode: 65, text: "a" });
    expect(keySpecFor("7")).toMatchObject({ code: "Digit7", keyCode: 55 });
    expect(keySpecFor("/")).toMatchObject({ code: "Slash", keyCode: 191 });
    expect(keySpecFor("F12")).toMatchObject({ code: "F12", keyCode: 123 });
    expect(keySpecFor("Enter")).toMatchObject({ code: "Enter", text: "\r" });
  });

  it("splits a chord into modifiers and one key, in any spelling", () => {
    expect(parseChord("ctrl+shift+a")).toMatchObject({ modifiers: ["Control", "Shift"], key: { key: "a" } });
    expect(parseChord("Control+C")).toMatchObject({ modifiers: ["Control"], key: { key: "C" } });
    expect(parseChord(["Meta", "v"])).toMatchObject({ modifiers: ["Meta"], key: { key: "v" } });
    expect(parseChord("ctrl++")).toMatchObject({ modifiers: ["Control"], key: { key: "+" } });
    expect(parseChord("Return")).toMatchObject({ modifiers: [], key: { key: "Enter" } });
  });

  it("treats a lone modifier as a key and a modifier-only chord as no key", () => {
    expect(parseChord("shift")).toMatchObject({ modifiers: [], key: { key: "Shift" } });
    expect(parseChord("ctrl+shift")).toMatchObject({ modifiers: ["Control", "Shift"], key: null });
  });

  it("rejects a chord with two ordinary keys", () => {
    expect(() => parseChord("a+b")).toThrow(/more than one/);
  });

  it("builds the CDP modifier bitmask", () => {
    expect(modifierMask(["Alt", "Control", "Meta", "Shift"])).toBe(15);
    expect(modifierMask(["Shift"])).toBe(8);
  });
});
