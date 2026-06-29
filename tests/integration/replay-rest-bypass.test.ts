import { describe, expect, it } from "vitest";

describe("REST pool connections bypass replay capture", () => {
  it("__pool=1 in the query string disables replay even when controller is set", () => {
    const url = new URL("ws://127.0.0.1:9500/v1/connect?token=t&provider=p&__pool=1");
    const isInternalPool = url.searchParams.get("__pool") === "1";
    expect(isInternalPool).toBe(true);
  });

  it("normal WS connect URLs do not set __pool", () => {
    const url = new URL("ws://localhost:9500/v1/connect");
    const isInternalPool = url.searchParams.get("__pool") === "1";
    expect(isInternalPool).toBe(false);
  });

  it("URL with provider but no __pool is treated as external (recordable)", () => {
    const url = new URL("ws://localhost:9500/v1/connect?provider=p");
    const isInternalPool = url.searchParams.get("__pool") === "1";
    expect(isInternalPool).toBe(false);
  });
});
