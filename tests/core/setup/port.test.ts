import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePort } from "../../../src/server/setup/port.js";

let prevBg: string | undefined;
let prevPort: string | undefined;

beforeEach(() => {
  prevBg = process.env.BG_PORT;
  prevPort = process.env.PORT;
  delete process.env.BG_PORT;
  delete process.env.PORT;
});
afterEach(() => {
  if (prevBg === undefined) delete process.env.BG_PORT;
  else process.env.BG_PORT = prevBg;
  if (prevPort === undefined) delete process.env.PORT;
  else process.env.PORT = prevPort;
});

describe("resolvePort", () => {
  it("CLI --port wins over env vars", () => {
    process.env.BG_PORT = "8001";
    process.env.PORT = "8002";
    expect(resolvePort("9000")).toBe(9000);
  });

  it("BG_PORT wins over PORT (gateway-native wins over 12-factor)", () => {
    process.env.BG_PORT = "8001";
    process.env.PORT = "8002";
    expect(resolvePort(undefined)).toBe(8001);
  });

  it("falls back to PORT when BG_PORT is unset (Railway/Render/Fly path)", () => {
    process.env.PORT = "8002";
    expect(resolvePort(undefined)).toBe(8002);
  });

  it("returns undefined when nothing is set (caller falls back to 9500)", () => {
    expect(resolvePort(undefined)).toBeUndefined();
  });

  it("returns undefined for non-numeric input", () => {
    expect(resolvePort("not-a-number")).toBeUndefined();
  });
});
