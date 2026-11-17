import { describe, expect, it } from "vitest";
import { parseProviderConfigBody } from "../../src/server/validation.js";
import { ProviderConfigSchema } from "../../src/core/types.js";
import { redactConnectionUrl } from "../../src/core/redact.js";

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

  it("refuses a masked value it cannot restore instead of saving the mask", () => {
    expect(parseProviderConfigBody({ url: "wss://provider.example/?***" }, existing).errors).toBeDefined();
    expect(parseProviderConfigBody({ headers: { "X-New": "***" } }, existing).errors).toBeDefined();
    expect(parseProviderConfigBody({ url: "wss://new.example/?apiKey=***" }).errors).toBeDefined();
  });

  it("restores a stored credential that itself contains *** instead of refusing the edit", () => {
    const stored = ProviderConfigSchema.parse({
      url: "wss://host.example/?token=abc***xyz",
      headers: { Authorization: "Bearer abc***xyz" },
      priority: 1,
    });
    const headerEdit = parseProviderConfigBody({ headers: { Authorization: "***" }, priority: 2 }, stored);
    expect(headerEdit.errors).toBeUndefined();
    expect(headerEdit.data?.headers?.Authorization).toBe("Bearer abc***xyz");
    const urlEdit = parseProviderConfigBody({ url: redactConnectionUrl(stored.url), priority: 2 }, stored);
    expect(urlEdit.errors).toBeUndefined();
    expect(urlEdit.data?.url).toBe(stored.url);
    expect(parseProviderConfigBody({ priority: 3 }, stored).errors).toBeUndefined();
  });

  it("handles an address that is null or not text the way it did before", () => {
    const keep = parseProviderConfigBody({ url: null, priority: 2 } as Record<string, unknown>, existing);
    expect(keep.errors).toBeUndefined();
    expect(keep.data?.url).toBe(existing.url);
    expect(parseProviderConfigBody({ url: 123 } as Record<string, unknown>, existing).errors).toBeDefined();
  });
});
