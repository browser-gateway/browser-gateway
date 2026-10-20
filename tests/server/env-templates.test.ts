import { afterEach, describe, expect, it, vi } from "vitest";
import { interpolateConfig, restoreEnvPlaceholders } from "../../src/server/config/env-templates.js";

afterEach(() => vi.unstubAllEnvs());

describe("config env placeholders", () => {
  it("resolves placeholders on load and puts them back unchanged on save", () => {
    vi.stubEnv("BG_T_TOKEN", "tok-1234567890");
    const raw = { providers: { a: { url: "wss://host/?token=${BG_T_TOKEN}", headers: { Authorization: "Bearer ${BG_T_TOKEN}" } } } };
    const { value, templates } = interpolateConfig(raw);
    expect(value).toEqual({ providers: { a: { url: "wss://host/?token=tok-1234567890", headers: { Authorization: "Bearer tok-1234567890" } } } });
    expect(restoreEnvPlaceholders(value, templates)).toEqual(raw);
  });

  it("masks a resolved secret that moved to another place or into an edited value", () => {
    vi.stubEnv("BG_T_TOKEN", "tok-1234567890");
    const { templates } = interpolateConfig({ providers: { a: { url: "wss://host/?token=${BG_T_TOKEN}" } } });
    const saved = restoreEnvPlaceholders({ providers: { b: { url: "wss://other/?token=tok-1234567890" } }, webhooks: [{ url: "https://hook/tok-1234567890" }] }, templates);
    expect(JSON.stringify(saved)).not.toContain("tok-1234567890");
    expect(saved).toEqual({ providers: { b: { url: "wss://other/?token=${BG_T_TOKEN}" } }, webhooks: [{ url: "https://hook/${BG_T_TOKEN}" }] });
  });

  it("writes values the user typed as typed and leaves short values alone", () => {
    vi.stubEnv("BG_T_LEVEL", "info");
    const { value, templates } = interpolateConfig({ logging: { level: "${BG_T_LEVEL}" }, note: "info" });
    expect(restoreEnvPlaceholders({ ...(value as object), logging: { level: "debug" } }, templates)).toEqual({ logging: { level: "debug" }, note: "info" });
    expect(restoreEnvPlaceholders(value, templates)).toEqual({ logging: { level: "${BG_T_LEVEL}" }, note: "info" });
  });

  it("keeps a default written in the placeholder", () => {
    const raw = { gateway: { name: "${BG_T_UNSET_VAR:-fallback-name}" } };
    const { value, templates } = interpolateConfig(raw);
    expect(value).toEqual({ gateway: { name: "fallback-name" } });
    expect(restoreEnvPlaceholders(value, templates)).toEqual(raw);
  });
});
