import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePort, resolveHost } from "../../../src/server/setup/port.js";

let prevPort: string | undefined;
let prevHost: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  prevPort = process.env.PORT;
  prevHost = process.env.HOST;
  prevToken = process.env.BG_TOKEN;
  delete process.env.PORT;
  delete process.env.HOST;
  delete process.env.BG_TOKEN;
});
afterEach(() => {
  if (prevPort === undefined) delete process.env.PORT;
  else process.env.PORT = prevPort;
  if (prevHost === undefined) delete process.env.HOST;
  else process.env.HOST = prevHost;
  if (prevToken === undefined) delete process.env.BG_TOKEN;
  else process.env.BG_TOKEN = prevToken;
});

describe("resolvePort", () => {
  it("CLI --port wins over PORT env", () => {
    process.env.PORT = "8002";
    expect(resolvePort("9000")).toBe(9000);
  });

  it("falls back to PORT (Railway/Render/Fly/Heroku convention)", () => {
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

describe("resolveHost", () => {
  it("defaults to 0.0.0.0 when BG_TOKEN is set", () => {
    process.env.BG_TOKEN = "a-token";
    expect(resolveHost()).toBe("0.0.0.0");
  });

  it("defaults to loopback when BG_TOKEN is unset", () => {
    delete process.env.BG_TOKEN;
    expect(resolveHost()).toBe("127.0.0.1");
  });

  it("honors HOST env var (loopback-only setup)", () => {
    process.env.HOST = "127.0.0.1";
    expect(resolveHost()).toBe("127.0.0.1");
  });

  it("honors HOST for IPv6 loopback", () => {
    process.env.HOST = "::1";
    expect(resolveHost()).toBe("::1");
  });
});
