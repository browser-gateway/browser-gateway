import { describe, expect, it } from "vitest";
import { checkUrl, fitFrame, frameToPage, fromGeminiGrid, geminiLength, pruneImages, visualTokens } from "../../src/agent-tools/computer-use/index.js";

describe("the screenshot frame the model sees", () => {
  it("keeps a 1440x900 page at full size for Claude", () => {
    expect(fitFrame({ width: 1440, height: 900 }, "anthropic-browser")).toEqual({ width: 1440, height: 900, scale: 1 });
    expect(visualTokens(1440, 900)).toBe(1716);
  });

  it("shrinks a large page until it fits Claude's size and token limits", () => {
    const frame = fitFrame({ width: 3000, height: 2000 }, "anthropic-browser");
    expect(frame.scale).toBeLessThan(1);
    expect(Math.max(frame.width, frame.height)).toBeLessThanOrEqual(2000);
    expect(visualTokens(frame.width, frame.height)).toBeLessThanOrEqual(4784);
  });

  it("never shrinks for Gemini", () => {
    expect(fitFrame({ width: 3000, height: 2000 }, "gemini").scale).toBe(1);
  });

  it("maps frame points back to page points and refuses points off the image", () => {
    const frame = { width: 720, height: 450, scale: 0.5 };
    expect(frameToPage({ x: 100, y: 50 }, frame)).toEqual({ x: 200, y: 100 });
    expect(() => frameToPage({ x: 720, y: 10 }, frame)).toThrow(/outside the 720x450 screenshot/);
    expect(() => frameToPage({ x: -1, y: 10 }, frame)).toThrow(/outside/);
  });

  it("reads Gemini's 0-999 grid, clamping values outside it", () => {
    const viewport = { width: 1440, height: 900 };
    expect(fromGeminiGrid({ x: 0, y: 0 }, viewport)).toEqual({ x: 0, y: 0 });
    expect(fromGeminiGrid({ x: 500, y: 500 }, viewport)).toEqual({ x: 720, y: 450 });
    expect(fromGeminiGrid({ x: 999, y: 999 }, viewport)).toEqual({ x: 1438, y: 899 });
    expect(fromGeminiGrid({ x: 1000, y: -5 }, viewport)).toEqual({ x: 1438, y: 0 });
    expect(geminiLength(800, 900)).toBe(720);
  });
});

describe("which addresses a model may open", () => {
  it("adds https to a bare address and keeps http and https", () => {
    expect(checkUrl("en.wikipedia.org/wiki/Cat")).toBe("https://en.wikipedia.org/wiki/Cat");
    expect(checkUrl("http://example.test/a")).toBe("http://example.test/a");
    expect(checkUrl("example.test:8080/x")).toBe("https://example.test:8080/x");
  });

  it("refuses other schemes", () => {
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "chrome://settings", "ftp://x.test"]) {
      expect(() => checkUrl(bad)).toThrow(/only http and https/);
    }
  });

  it("refuses local and private network addresses unless allowed", () => {
    for (const bad of ["localhost:3000", "http://127.0.0.1/", "http://10.1.2.3/", "http://192.168.0.1/", "http://169.254.169.254/latest", "http://[::1]/"]) {
      expect(() => checkUrl(bad)).toThrow(/private network/);
    }
    expect(checkUrl("http://127.0.0.1/", { blockPrivateNetworks: false })).toBe("http://127.0.0.1/");
  });

  it("keeps a session to its allowed sites", () => {
    const urls = { allowedHosts: ["wikipedia.org"] };
    expect(checkUrl("https://en.wikipedia.org/", urls)).toBe("https://en.wikipedia.org/");
    expect(() => checkUrl("https://evil.test/", urls)).toThrow(/not on the list/);
    expect(() => checkUrl("https://notwikipedia.org/", urls)).toThrow(/not on the list/);
  });
});

describe("trimming old screenshots from a conversation", () => {
  const image = (n: number) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: `img${n}` } });

  it("keeps the last screenshots in Claude messages and leaves the input untouched", () => {
    const messages = [1, 2, 3, 4].map((n) => ({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${n}`, content: [image(n)] }],
    }));
    const pruned = pruneImages(messages, 2);
    const kept = JSON.stringify(pruned);
    expect(kept).not.toContain("img1");
    expect(kept).not.toContain("img2");
    expect(kept).toContain("img3");
    expect(kept).toContain("img4");
    expect(kept).toContain("earlier screenshot removed");
    expect(JSON.stringify(messages)).toContain("img1");
  });

  it("handles both Gemini request shapes", () => {
    const interactions = [1, 2].map((n) => ({ type: "function_result", result: [{ type: "image", data: `g${n}`, mime_type: "image/png" }] }));
    expect(JSON.stringify(pruneImages(interactions, 1))).not.toContain("g1");
    const contents = [1, 2].map((n) => ({ role: "user", parts: [{ functionResponse: { name: "click", response: {}, parts: [{ inlineData: { mimeType: "image/png", data: `c${n}` } }] } }] }));
    const pruned = JSON.stringify(pruneImages(contents, 1));
    expect(pruned).not.toContain("c1");
    expect(pruned).toContain("c2");
  });
});
