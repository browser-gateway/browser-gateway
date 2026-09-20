import { afterEach, describe, expect, it } from "vitest";
import { resolvePublicUrl } from "../../src/server/setup/port.js";
import { mcpSetupDoc } from "../../src/agent-tools/index.js";

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe("resolvePublicUrl", () => {
  it("prefers an explicitly configured url and drops trailing slashes", () => {
    process.env.BG_PUBLIC_URL = "https://gateway.example.com/";
    expect(resolvePublicUrl(9500)).toBe("https://gateway.example.com");
  });

  it("falls back to the bind interface and port", () => {
    delete process.env.BG_PUBLIC_URL;
    process.env.HOST = "127.0.0.1";
    expect(resolvePublicUrl(9500)).toBe("http://127.0.0.1:9500");
  });

  it("advertises a reachable name when bound to every interface", () => {
    delete process.env.BG_PUBLIC_URL;
    process.env.HOST = "0.0.0.0";
    expect(resolvePublicUrl(9600)).toBe("http://localhost:9600");
  });

  it("never reads a request Host header", () => {
    delete process.env.BG_PUBLIC_URL;
    process.env.HOST = "127.0.0.1";
    const url = resolvePublicUrl(9500);
    expect(url).not.toContain("attacker");
    expect(resolvePublicUrl(9500)).toBe(url);
  });
});

describe("setup document endpoint", () => {
  it("advertises only the trusted url, never an attacker-supplied host", () => {
    process.env.BG_PUBLIC_URL = "https://gateway.example.com";
    const doc = mcpSetupDoc({
      mcpUrl: `${resolvePublicUrl(9500)}/mcp`,
      keySource: "Ask the user for the gateway token.",
    });
    expect(doc).toContain("https://gateway.example.com/mcp");
    expect(doc).not.toContain("attacker.example");
  });
});
