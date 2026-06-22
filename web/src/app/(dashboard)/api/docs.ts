/**
 * Reference documentation for the three /v1 REST endpoints, in a shape the
 * `EndpointReference` component can render. Keeping these as plain data
 * (instead of inside the page component) makes the reference content easier
 * to maintain and would let us validate it against the Zod schemas in a future
 * test.
 */
import type { EndpointDoc } from "@/components/endpoint-reference";

const COMMON_HEADERS: EndpointDoc["headers"] = [
  { name: "Content-Type", value: "application/json", note: "Required." },
  {
    name: "Authorization",
    value: "Bearer YOUR_BG_TOKEN",
    note: "Required when BG_TOKEN is set. Or use the bg_session cookie (set by the dashboard login).",
  },
];

const COMMON_PARAMS_BEFORE_PROFILE = [
  { name: "url", type: "string", required: true, description: "URL to load." },
  {
    name: "viewport",
    type: "object",
    default: "1280x720",
    description: "Browser viewport size. Shape: { width, height }.",
  },
  {
    name: "waitUntil",
    type: "string",
    default: "load",
    description: "Navigation wait condition. One of load, domcontentloaded, networkidle, commit.",
  },
  {
    name: "waitForSelector",
    type: "string",
    description: "CSS selector to wait for after navigation, up to 10s.",
  },
  { name: "waitForTimeout", type: "number", description: "Additional ms to wait after load (0-30000)." },
  { name: "timeout", type: "number", default: "30000", description: "Total navigation timeout in ms (1000-60000)." },
  { name: "retries", type: "number", default: "2", description: "Retry attempts on retryable errors (0-5)." },
  { name: "headers", type: "object", description: "Extra HTTP headers as { name: value }." },
  { name: "userAgent", type: "string", description: "Override the browser's user agent." },
];

const PROFILE_PARAM = {
  name: "profile",
  type: "string",
  description:
    "Optional profile id. When set, the request runs with the saved cookies + storage of that profile and captures the latest state on success. Disables retries (one-shot).",
};

export const screenshotDoc: EndpointDoc = {
  description:
    "Capture a screenshot of any URL. Returns raw image bytes (PNG or JPEG). Supports full-page captures, element-only captures via CSS selector, and arbitrary region clips.",
  headers: COMMON_HEADERS,
  parameters: [
    ...COMMON_PARAMS_BEFORE_PROFILE,
    { name: "format", type: '"png" | "jpeg"', default: "png", description: "Image format." },
    { name: "fullPage", type: "boolean", default: "false", description: "Scroll and stitch the entire scrollable area." },
    { name: "quality", type: "number", description: "JPEG quality 0-100. Ignored when format=png." },
    { name: "selector", type: "string", description: "Capture only the element matching this CSS selector." },
    {
      name: "clip",
      type: "object",
      description: "Capture only a region. Shape: { x, y, width, height }.",
    },
    { name: "omitBackground", type: "boolean", default: "false", description: "Render with a transparent background (PNG only)." },
    { name: "scrollPage", type: "boolean", default: "false", description: "Scroll through the page before capture, useful for lazy-loaded content." },
    PROFILE_PARAM,
  ],
  requestExample: `{
  "url": "https://example.com",
  "format": "png",
  "fullPage": true,
  "viewport": { "width": 1440, "height": 900 }
}`,
  responseDescription:
    "Returns the raw image bytes with Content-Type: image/png or image/jpeg. Save the response body to a file to view it.",
  responseExample: null,
  responseHeaders: [
    { name: "Content-Type", description: "image/png or image/jpeg" },
    { name: "X-Response-Code", description: "Upstream HTTP status of the navigated page." },
    { name: "X-Response-URL", description: "Final URL after any redirects." },
    { name: "X-Timing-Total-Ms", description: "Total time from request to response, in milliseconds." },
    { name: "X-Timing-Navigation-Ms", description: "Time spent on page.goto, in milliseconds." },
  ],
  errors: [
    { status: 200, meaning: "Success. Body is the image." },
    { status: 400, meaning: "Validation error or profile feature disabled." },
    { status: 408, meaning: "Navigation timed out." },
    { status: 409, meaning: "Profile is currently in use by another session." },
    { status: 500, meaning: "Internal error or upstream provider error." },
    { status: 503, meaning: "No providers available or all providers in cooldown." },
  ],
};

export const contentDoc: EndpointDoc = {
  description:
    "Fetch a page and return its content in one or more formats. Useful for AI agents that need clean text, scrapers that want markdown, or any workflow that doesn't need to render images.",
  headers: COMMON_HEADERS,
  parameters: [
    ...COMMON_PARAMS_BEFORE_PROFILE,
    {
      name: "formats",
      type: "array<string>",
      default: '["markdown"]',
      description: "Which formats to extract. Any combination of: html, markdown, text, readability.",
    },
    PROFILE_PARAM,
  ],
  requestExample: `{
  "url": "https://example.com",
  "formats": ["markdown", "text"]
}`,
  responseDescription:
    "JSON object with the extracted content, metadata pulled from the page, and a links array (anchor href + visible text for every link on the page).",
  responseExample: `{
  "success": true,
  "data": {
    "content": {
      "markdown": "# Example Domain\\n\\nThis domain is for use in illustrative examples...",
      "text": "Example Domain\\n\\nThis domain is for use in illustrative examples..."
    },
    "metadata": {
      "title": "Example Domain",
      "description": "...",
      "ogImage": "..."
    },
    "links": [
      { "url": "https://www.iana.org/domains/example", "text": "More information..." }
    ],
    "resolvedUrl": "https://example.com/",
    "statusCode": 200,
    "timings": { "total": 432, "navigation": 380, "action": 52 }
  }
}`,
  errors: [
    { status: 200, meaning: "Success." },
    { status: 400, meaning: "Validation error or profile feature disabled." },
    { status: 408, meaning: "Navigation timed out." },
    { status: 409, meaning: "Profile is currently in use by another session." },
    { status: 500, meaning: "Internal error." },
    { status: 503, meaning: "No providers available." },
  ],
};

export const scrapeDoc: EndpointDoc = {
  description:
    "Extract structured data from a page using CSS selectors. Optionally combines the selector results with full-page content formats and a screenshot, so a single request can capture everything you need.",
  headers: COMMON_HEADERS,
  parameters: [
    ...COMMON_PARAMS_BEFORE_PROFILE,
    {
      name: "selectors",
      type: "array<object>",
      description:
        "Named CSS selectors. Each entry: { name, selector, attribute? }. Each returns its matches with text + outer HTML.",
    },
    {
      name: "formats",
      type: "array<string>",
      description: "Optional. Also return full-page content in any of: html, markdown, text, readability.",
    },
    { name: "screenshot", type: "boolean", default: "false", description: "Also capture a base64 PNG of the page." },
    PROFILE_PARAM,
  ],
  requestExample: `{
  "url": "https://example.com",
  "selectors": [
    { "name": "title", "selector": "h1" },
    { "name": "links", "selector": "a", "attribute": "href" }
  ],
  "formats": ["markdown"]
}`,
  responseDescription:
    "JSON object with selector results, optional content formats, optional metadata, and an optional base64-encoded screenshot.",
  responseExample: `{
  "success": true,
  "data": {
    "selectors": [
      {
        "name": "title",
        "selector": "h1",
        "results": [{ "text": "Example Domain", "html": "<h1>Example Domain</h1>" }]
      },
      {
        "name": "links",
        "selector": "a",
        "results": [{ "text": "More information...", "html": "<a href=\\"...\\">...</a>", "attribute": "https://www.iana.org/domains/example" }]
      }
    ],
    "content": { "markdown": "# Example Domain..." },
    "screenshot": null,
    "resolvedUrl": "https://example.com/",
    "statusCode": 200,
    "timings": { "total": 380, "navigation": 350, "action": 30 }
  }
}`,
  errors: [
    { status: 200, meaning: "Success." },
    { status: 400, meaning: "Validation error, missing selectors and formats, or profile feature disabled." },
    { status: 408, meaning: "Navigation timed out." },
    { status: 409, meaning: "Profile is currently in use by another session." },
    { status: 500, meaning: "Internal error." },
    { status: 503, meaning: "No providers available." },
  ],
};
