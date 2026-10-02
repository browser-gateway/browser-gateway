import { describe, it, expect } from "vitest";
import { isReadOnlyProfileRequest } from "../../src/server/profile/lifecycle.js";

describe("isReadOnlyProfileRequest", () => {
  it.each(["1", "true", "TRUE", "yes"])("treats readOnly=%s as read-only", (v) => {
    expect(isReadOnlyProfileRequest(new URL(`ws://g/v1/live?profile=p&readOnly=${v}`))).toBe(true);
  });

  it.each(["0", "false", ""])("saves when readOnly=%s", (v) => {
    expect(isReadOnlyProfileRequest(new URL(`ws://g/v1/live?profile=p&readOnly=${v}`))).toBe(false);
  });

  it("saves when the flag is absent", () => {
    expect(isReadOnlyProfileRequest(new URL("ws://g/v1/connect?profile=p"))).toBe(false);
  });
});
