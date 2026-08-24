import { describe, it, expect } from "vitest";
import {
  isProbeableUrl,
  providerProbeCacheKey,
  selectProfileHint,
  PROVIDER_FORM_COPY,
} from "../../src/provider-form/index.js";

const copy = PROVIDER_FORM_COPY.profile;

describe("isProbeableUrl", () => {
  it("accepts ws, wss, http, https", () => {
    expect(isProbeableUrl("ws://localhost:9222")).toBe(true);
    expect(isProbeableUrl("wss://provider.example.com?token=x")).toBe(true);
    expect(isProbeableUrl("http://localhost:9222")).toBe(true);
    expect(isProbeableUrl("https://cdp.example.com")).toBe(true);
  });
  it("rejects half-typed input", () => {
    expect(isProbeableUrl("")).toBe(false);
    expect(isProbeableUrl("wss:/")).toBe(false);
    expect(isProbeableUrl("provider.example.com")).toBe(false);
    expect(isProbeableUrl("javascript:alert(1)")).toBe(false);
  });
  it("trims surrounding whitespace", () => {
    expect(isProbeableUrl("  wss://a.b  ")).toBe(true);
  });
});

describe("providerProbeCacheKey", () => {
  it("differs when URL changes", () => {
    const a = providerProbeCacheKey("wss://a", undefined);
    const b = providerProbeCacheKey("wss://b", undefined);
    expect(a).not.toBe(b);
  });
  it("differs when header value changes", () => {
    const a = providerProbeCacheKey("wss://a", { Authorization: "Bearer 1" });
    const b = providerProbeCacheKey("wss://a", { Authorization: "Bearer 2" });
    expect(a).not.toBe(b);
  });
  it("differs when a header is added", () => {
    const a = providerProbeCacheKey("wss://a", undefined);
    const b = providerProbeCacheKey("wss://a", { X: "y" });
    expect(a).not.toBe(b);
  });
  it("is stable across header-key reorderings", () => {
    const a = providerProbeCacheKey("wss://a", { A: "1", B: "2" });
    const b = providerProbeCacheKey("wss://a", { B: "2", A: "1" });
    expect(a).toBe(b);
  });
  it("normalizes leading/trailing whitespace on URL", () => {
    expect(providerProbeCacheKey("  wss://a  ", undefined)).toBe(providerProbeCacheKey("wss://a", undefined));
  });
});

describe("selectProfileHint", () => {
  it("returns hintNone for empty profile", () => {
    expect(selectProfileHint("", { status: "idle" }, copy)).toBe(copy.hintNone);
  });
  it("returns hintPinned for a specific slug", () => {
    expect(selectProfileHint("my-slug", { status: "idle" }, copy)).toBe(copy.hintPinned("my-slug"));
  });
  it("returns the detecting hint while probing", () => {
    expect(selectProfileHint("*", { status: "probing" }, copy)).toBe(copy.hintAnyDetecting);
  });
  it("returns the browserserve-positive hint on a browserserve provider", () => {
    const state = { status: "done" as const, result: { detectedKind: "browserserve" as const, advertisedMaxConcurrent: null } };
    expect(selectProfileHint("*", state, copy)).toBe(copy.hintAny);
  });
  it("returns the external-warning hint on a generic CDP provider", () => {
    const state = { status: "done" as const, result: { detectedKind: "generic" as const, advertisedMaxConcurrent: null } };
    expect(selectProfileHint("*", state, copy)).toBe(copy.hintAnyExternal);
  });
  it("returns the external-warning hint when probe status is unknown", () => {
    expect(selectProfileHint("*", { status: "unknown" }, copy)).toBe(copy.hintAnyExternal);
  });
  it("returns the external-warning hint when probe is idle (default caution)", () => {
    expect(selectProfileHint("*", { status: "idle" }, copy)).toBe(copy.hintAnyExternal);
  });
});
