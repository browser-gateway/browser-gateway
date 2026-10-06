import { describe, expect, it } from "vitest";
import { findElements, redactUrl } from "../../src/agent-tools/index.js";

describe("finding elements by description", () => {
  const entries: Array<[string, { role: string; name: string }]> = [
    ["e1", { role: "button", name: "Save changes" }],
    ["e2", { role: "textbox", name: "Email address" }],
    ["e3", { role: "link", name: "Change password" }],
  ];

  it("ranks the element whose name shares the most words first", () => {
    expect(findElements("save my changes", entries)[0]?.ref).toBe("e1");
    expect(findElements("the email input", entries)[0]?.ref).toBe("e2");
  });

  it("returns nothing when no word matches", () => {
    expect(findElements("weather forecast", entries)).toEqual([]);
    expect(findElements("the a", entries)).toEqual([]);
  });
});

describe("redacting logged addresses", () => {
  it("keeps origin and path and drops the query and fragment", () => {
    expect(redactUrl("https://api.test/v1/x?token=abc#frag")).toBe("https://api.test/v1/x?...");
    expect(redactUrl("https://api.test/v1/x")).toBe("https://api.test/v1/x");
    expect(redactUrl("data:text/plain,hello")).toBe("data:...");
  });
});
