import type { Page } from "playwright-core";
import type { Logger } from "pino";
import type { Gateway } from "../../core/index.js";
import type { SessionPool } from "../../core/pool/index.js";
import type { ProfileLifecycle } from "../profile/lifecycle.js";
import { ScrapeRequestSchema } from "./schemas.js";
import { dispatchPageAction } from "./dispatch.js";
import { extractFormats, pageOptionsFromBody } from "./rest-helpers.js";
import type { Context } from "hono";

interface SelectorResult {
  name: string;
  selector: string;
  results: Array<{
    text: string;
    html: string;
    attribute?: string;
  }>;
}

interface ScrapeData {
  selectors?: SelectorResult[];
  content?: Record<string, string>;
  metadata?: Record<string, unknown>;
  screenshot?: string;
}

export async function handleScrape(
  c: Context,
  pool: SessionPool,
  gateway: Gateway,
  logger: Logger,
  profileLifecycle?: ProfileLifecycle,
) {
  const body = ScrapeRequestSchema.parse(await c.req.json());

  const result = await dispatchPageAction(
    { pool, gateway, logger, profileLifecycle },
    body.profile,
    pageOptionsFromBody(body, c),
    async (page: Page): Promise<ScrapeData> => {
      const output: ScrapeData = {};

      // Selector-based extraction
      if (body.selectors) {
        output.selectors = await page.evaluate(
          `(${JSON.stringify(body.selectors)}).map(({ name, selector, attribute }) => {
            const elements = document.querySelectorAll(selector);
            return {
              name,
              selector,
              results: Array.from(elements).map(el => ({
                text: (el.textContent || "").trim(),
                html: el.innerHTML,
                ...(attribute ? { attribute: el.getAttribute(attribute) || "" } : {}),
              })),
            };
          })`,
        ) as SelectorResult[];
      }

      // Full-page content extraction
      if (body.formats) {
        const rawHtml = await page.content();
        const { content, metadata } = await extractFormats(
          rawHtml,
          page.url(),
          () => page.evaluate("document.body.innerText") as Promise<string>,
          body.formats,
        );
        output.content = content;
        if (metadata) output.metadata = metadata;
      }

      if (body.screenshot) {
        const buf = await page.screenshot({
          fullPage: false,
          type: "jpeg",
          quality: 80,
        });
        output.screenshot = buf.toString("base64");
      }

      return output;
    },
  );

  return c.json({
    success: true,
    data: {
      url: result.resolvedUrl,
      statusCode: result.statusCode,
      ...result.data,
    },
    timings: result.timings,
  });
}
