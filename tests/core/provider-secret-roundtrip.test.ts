import { describe, expect, it } from "vitest";
import { parseProviderConfigBody } from "../../src/server/validation.js";
import { ProviderConfigSchema } from "../../src/core/types.js";

const existing = ProviderConfigSchema.parse({
  url: "wss://user:PASSWORD@provider.example/?apiKey=SECRET",
  headers: { Authorization: "Bearer PROVIDER_BEARER", "X-Region": "eu" },
  priority: 1,
});

describe("parseProviderConfigBody masked-value handling", () => {
  it("keeps the stored URL when the caller echoes the masked one", () => {
    const parsed = parseProviderConfigBody(
      { url: "wss://***:***@provider.example/?apiKey=***" },
      existing,
    );
    expect(parsed.data?.url).toBe(existing.url);
  });

  it("keeps the stored header when the caller echoes the mask", () => {
    const parsed = parseProviderConfigBody(
      { headers: { Authorization: "***", "X-Region": "eu" } },
      existing,
    );
    expect(parsed.data?.headers?.Authorization).toBe("Bearer PROVIDER_BEARER");
  });

  it("accepts a genuinely new value", () => {
    const parsed = parseProviderConfigBody(
      { url: "wss://other.example/", headers: { Authorization: "Bearer NEW" } },
      existing,
    );
    expect(parsed.data?.url).toBe("wss://other.example/");
    expect(parsed.data?.headers?.Authorization).toBe("Bearer NEW");
  });
});
