import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fallbackReason, hookOutput } from "../../plugins/browser-gateway/hooks/webfetch-fallback.mjs";

const HOOK = fileURLToPath(new URL("../../plugins/browser-gateway/hooks/webfetch-fallback.mjs", import.meta.url));

function after(url: string, response: unknown) {
  return { hook_event_name: "PostToolUse", tool_name: "WebFetch", tool_input: { url, prompt: "x" }, tool_response: response };
}

function failure(url: string, error: string) {
  return { hook_event_name: "PostToolUseFailure", tool_name: "WebFetch", tool_input: { url, prompt: "x" }, error };
}

describe("WebFetch fallback hook", () => {
  it("nudges after a blocked or paywalled response", () => {
    expect(fallbackReason(after("https://www.g2.com/p", { code: 403, bytes: 0, result: "HTTP 403" }))).toBe("HTTP 403");
    expect(fallbackReason(after("https://x.com/a", { code: 402, bytes: 0 }))).toBe("HTTP 402");
    expect(fallbackReason(after("https://a.com", { code: 429, bytes: 0 }))).toBe("HTTP 429");
  });

  it("nudges on an empty page and on a bot check that came back 200", () => {
    expect(fallbackReason(after("https://a.com", { code: 200, bytes: 0, result: "" }))).toBe("an empty page");
    expect(fallbackReason(after("https://a.com", { code: 200, bytes: 900, result: "Just a moment... checking your browser" }))).toContain(
      "bot check",
    );
    expect(fallbackReason(after("https://a.com", "The page says: You need to enable JavaScript to run this app."))).toContain(
      "JavaScript",
    );
  });

  it("stays silent when a browser would not help", () => {
    expect(fallbackReason(after("https://a.com/gone", { code: 404, bytes: 10 }))).toBeUndefined();
    expect(fallbackReason(after("https://en.wikipedia.org/wiki/HTTP", { code: 200, bytes: 5000, result: "HTTP is a protocol" }))).toBeUndefined();
    expect(fallbackReason(failure("https://nope.invalid", "getaddrinfo ENOTFOUND nope.invalid"))).toBeUndefined();
    expect(fallbackReason(after("http://localhost:3000", { code: 500, bytes: 0 }))).toBeUndefined();
    expect(fallbackReason(after("not a url", { code: 403 }))).toBeUndefined();
  });

  it("nudges after a failure that is not a missing host", () => {
    expect(fallbackReason(failure("https://a.com", "socket hang up"))).toBe("socket hang up");
  });

  it("names the url and the tools in the context it adds", () => {
    const out = hookOutput(after("https://www.g2.com/p", { code: 403, bytes: 0 }));
    expect(out?.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out?.hookSpecificOutput.additionalContext).toContain("https://www.g2.com/p");
    expect(out?.hookSpecificOutput.additionalContext).toContain("fetch_page");
  });

  it("reads the event from stdin and prints nothing for a healthy fetch", () => {
    const blocked = execFileSync(process.execPath, [HOOK], { input: JSON.stringify(after("https://a.com", { code: 403, bytes: 0 })) });
    expect(JSON.parse(String(blocked)).hookSpecificOutput.additionalContext).toContain("HTTP 403");
    const healthy = execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify(after("https://a.com", { code: 200, bytes: 4000, result: "fine" })),
    });
    expect(String(healthy)).toBe("");
    expect(String(execFileSync(process.execPath, [HOOK], { input: "not json" }))).toBe("");
  });
});
