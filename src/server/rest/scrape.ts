import type { Page } from "playwright-core";
import type { Logger } from "pino";
import type { SessionPool } from "../../core/pool/index.js";
import { ScrapeRequestSchema } from "./schemas.js";
import { withBrowserPage } from "./executor.js";
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

async function extractWithDefuddle(rawHtml: string, pageUrl: string, markdown: boolean) {
  const { parseHTML } = await import("linkedom");
  const { Defuddle } = await import("defuddle/node");

  const { document } = parseHTML(rawHtml);
  return await Defuddle(document, pageUrl, { markdown });
}

export async function handleScrape(c: Context, pool: SessionPool, logger: Logger) {
  const body = ScrapeRequestSchema.parse(await c.req.json());

  const result = await withBrowserPage(
    pool,
    logger,
    {
      url: body.url,
      viewport: body.viewport,
      waitUntil: body.waitUntil,
      waitForSelector: body.waitForSelector,
      waitForTimeout: body.waitForTimeout,
      timeout: body.timeout,
      headers: body.headers,
      userAgent: body.userAgent,
      retries: body.retries,
      signal: c.req.raw.signal,
    },
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
        output.content = {};

        if (body.formats.includes("html")) {
          output.content.html = rawHtml;
        }

        if (body.formats.includes("text")) {
          output.content.text = await page.evaluate("document.body.innerText") as string;
        }

        const needsDefuddle =
          body.formats.includes("markdown") ||
          body.formats.includes("readability");

        if (needsDefuddle) {
          const wantsMarkdown = body.formats.includes("markdown");
          const wantsReadability = body.formats.includes("readability");

          if (wantsReadability) {
            const defuddled = await extractWithDefuddle(rawHtml, page.url(), false);
            output.content.readability = defuddled.content;
            output.metadata = {
              title: defuddled.title,
              description: defuddled.description,
              author: defuddled.author,
              wordCount: defuddled.wordCount,
            };
          }

          if (wantsMarkdown) {
            const mdResult = await extractWithDefuddle(rawHtml, page.url(), true);
            output.content.markdown = mdResult.content;
            if (!wantsReadability) {
              output.metadata = {
                title: mdResult.title,
                description: mdResult.description,
                author: mdResult.author,
                wordCount: mdResult.wordCount,
              };
            }
          }
        }
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
