import { describe, it, expect } from "vitest";
import {
  ScreenshotRequestSchema,
  ContentRequestSchema,
  ScrapeRequestSchema,
  RestApiError,
} from "../../src/server/rest/schemas.js";

describe("ScreenshotRequestSchema", () => {
  it("should accept minimal valid request", () => {
    const result = ScreenshotRequestSchema.parse({
      url: "https://example.com",
    });
    expect(result.url).toBe("https://example.com");
    expect(result.fullPage).toBe(false);
    expect(result.format).toBe("png");
    expect(result.omitBackground).toBe(false);
    expect(result.scrollPage).toBe(false);
    expect(result.waitUntil).toBe("load");
    expect(result.timeout).toBe(30000);
  });

  it("should accept full request with all options", () => {
    const result = ScreenshotRequestSchema.parse({
      url: "https://example.com",
      fullPage: true,
      format: "jpeg",
      quality: 90,
      selector: "#main",
      viewport: { width: 1920, height: 1080 },
      scrollPage: true,
      omitBackground: true,
      waitUntil: "networkidle",
      waitForSelector: ".loaded",
      waitForTimeout: 2000,
      timeout: 45000,
      headers: { "X-Custom": "value" },
      userAgent: "TestAgent/1.0",
    });
    expect(result.fullPage).toBe(true);
    expect(result.format).toBe("jpeg");
    expect(result.quality).toBe(90);
    expect(result.selector).toBe("#main");
    expect(result.viewport?.width).toBe(1920);
  });

  it("should accept clip option", () => {
    const result = ScreenshotRequestSchema.parse({
      url: "https://example.com",
      clip: { x: 0, y: 0, width: 800, height: 600 },
    });
    expect(result.clip?.width).toBe(800);
  });

  it("should reject invalid URL", () => {
    expect(() =>
      ScreenshotRequestSchema.parse({ url: "not-a-url" }),
    ).toThrow();
  });

  it("should reject invalid format", () => {
    expect(() =>
      ScreenshotRequestSchema.parse({
        url: "https://example.com",
        format: "bmp",
      }),
    ).toThrow();
  });

  it("should reject quality out of range", () => {
    expect(() =>
      ScreenshotRequestSchema.parse({
        url: "https://example.com",
        quality: 150,
      }),
    ).toThrow();
  });

  it("should reject timeout below minimum", () => {
    expect(() =>
      ScreenshotRequestSchema.parse({
        url: "https://example.com",
        timeout: 100,
      }),
    ).toThrow();
  });

  it("should reject timeout above maximum", () => {
    expect(() =>
      ScreenshotRequestSchema.parse({
        url: "https://example.com",
        timeout: 120000,
      }),
    ).toThrow();
  });

  it("should reject viewport dimensions out of range", () => {
    expect(() =>
      ScreenshotRequestSchema.parse({
        url: "https://example.com",
        viewport: { width: 0, height: 720 },
      }),
    ).toThrow();
  });

  it("should reject clip with negative dimensions", () => {
    expect(() =>
      ScreenshotRequestSchema.parse({
        url: "https://example.com",
        clip: { x: 0, y: 0, width: -100, height: 600 },
      }),
    ).toThrow();
  });
});

describe("ContentRequestSchema", () => {
  it("should accept minimal valid request", () => {
    const result = ContentRequestSchema.parse({
      url: "https://example.com",
    });
    expect(result.formats).toEqual(["markdown"]);
    expect(result.waitUntil).toBe("domcontentloaded");
    expect(result.timeout).toBe(30000);
  });

  it("should accept multiple formats", () => {
    const result = ContentRequestSchema.parse({
      url: "https://example.com",
      formats: ["html", "markdown", "text", "readability"],
    });
    expect(result.formats).toHaveLength(4);
  });

  it("should reject empty formats array", () => {
    expect(() =>
      ContentRequestSchema.parse({
        url: "https://example.com",
        formats: [],
      }),
    ).toThrow();
  });

  it("should reject invalid format value", () => {
    expect(() =>
      ContentRequestSchema.parse({
        url: "https://example.com",
        formats: ["pdf"],
      }),
    ).toThrow();
  });

  it("should accept all wait options", () => {
    const result = ContentRequestSchema.parse({
      url: "https://example.com",
      waitForSelector: "#content",
      waitForTimeout: 5000,
    });
    expect(result.waitForSelector).toBe("#content");
    expect(result.waitForTimeout).toBe(5000);
  });
});

describe("ScrapeRequestSchema", () => {
  it("should accept selector-based request", () => {
    const result = ScrapeRequestSchema.parse({
      url: "https://example.com",
      selectors: [
        { name: "title", selector: "h1" },
        { name: "price", selector: ".price", attribute: "data-value" },
      ],
    });
    expect(result.selectors).toHaveLength(2);
    expect(result.selectors![0].name).toBe("title");
    expect(result.selectors![1].attribute).toBe("data-value");
  });

  it("should accept format-based request", () => {
    const result = ScrapeRequestSchema.parse({
      url: "https://example.com",
      formats: ["markdown", "html"],
    });
    expect(result.formats).toHaveLength(2);
  });

  it("should accept both selectors and formats", () => {
    const result = ScrapeRequestSchema.parse({
      url: "https://example.com",
      selectors: [{ name: "title", selector: "h1" }],
      formats: ["markdown"],
      screenshot: true,
    });
    expect(result.selectors).toHaveLength(1);
    expect(result.formats).toHaveLength(1);
    expect(result.screenshot).toBe(true);
  });

  it("should reject request with neither selectors nor formats", () => {
    expect(() =>
      ScrapeRequestSchema.parse({
        url: "https://example.com",
      }),
    ).toThrow();
  });

  it("should default screenshot to false", () => {
    const result = ScrapeRequestSchema.parse({
      url: "https://example.com",
      selectors: [{ name: "title", selector: "h1" }],
    });
    expect(result.screenshot).toBe(false);
  });

  it("should default waitUntil to domcontentloaded", () => {
    const result = ScrapeRequestSchema.parse({
      url: "https://example.com",
      formats: ["text"],
    });
    expect(result.waitUntil).toBe("domcontentloaded");
  });
});

describe("RestApiError", () => {
  it("should create error with status and message", () => {
    const err = new RestApiError(503, "No providers available");
    expect(err.status).toBe(503);
    expect(err.message).toBe("No providers available");
    expect(err.name).toBe("RestApiError");
    expect(err instanceof Error).toBe(true);
  });
});
