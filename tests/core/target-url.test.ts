import { describe, expect, it } from "vitest";
import { checkTargetUrl, isPrivateAddress } from "../../src/core/target-url.js";

describe("checkTargetUrl", () => {
  it("allows a public http and https target", () => {
    expect(checkTargetUrl("https://example.com/page").ok).toBe(true);
    expect(checkTargetUrl("http://example.com/page").ok).toBe(true);
  });

  it("rejects file: URLs", () => {
    const verdict = checkTargetUrl("file:///etc/passwd");
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("file");
  });

  it("rejects other non-http schemes", () => {
    for (const url of ["gopher://example.com/", "javascript:alert(1)", "data:text/html,x", "ftp://example.com/x"]) {
      expect(checkTargetUrl(url).ok).toBe(false);
    }
  });

  it("rejects loopback, link-local and private hosts", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "127.5.5.5",
      "[::1]",
      "169.254.169.254",
      "10.0.0.5",
      "172.16.3.4",
      "192.168.1.1",
      "100.64.0.1",
      "staging.internal",
      "box.local",
    ]) {
      expect(checkTargetUrl(`http://${host}/`).ok, host).toBe(false);
    }
  });

  it("allows a private host that the policy names", () => {
    const verdict = checkTargetUrl("http://staging.internal/health", {
      allowedPrivateHosts: ["Staging.Internal"],
    });
    expect(verdict.ok).toBe(true);
  });

  it("rejects a non-URL string", () => {
    expect(checkTargetUrl("not-a-url").ok).toBe(false);
  });
});

describe("isPrivateAddress", () => {
  it("classifies public addresses as public", () => {
    for (const host of ["8.8.8.8", "93.184.216.34", "example.com", "2606:2800:220:1::"]) {
      expect(isPrivateAddress(host), host).toBe(false);
    }
  });

  it("classifies IPv6 loopback, unique-local and mapped addresses as private", () => {
    for (const host of ["::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(host), host).toBe(true);
    }
  });
});
