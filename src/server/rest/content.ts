import type { Page } from "playwright-core";
import type { Logger } from "pino";
import type { SessionPool } from "../../core/pool/index.js";
import { ContentRequestSchema } from "./schemas.js";
import { withBrowserPage } from "./executor.js";
import type { Context } from "hono";

interface ContentData {
  content: Record<string, string>;
  metadata: Record<string, unknown>;
  links: Array<{ url: string; text: string }>;
}

async function extractWithDefuddle(rawHtml: string, pageUrl: string, markdown: boolean) {
  const { parseHTML } = await import("linkedom");
  const { Defuddle } = await import("defuddle/node");

  const { document } = parseHTML(rawHtml);
  return await Defuddle(document, pageUrl, { markdown });
}

export async function handleContent(c: Context, pool: SessionPool, logger: Logger) {
  const body = ContentRequestSchema.parse(await c.req.json());

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
    async (page: Page): Promise<ContentData> => {
      const content: Record<string, string> = {};
      let metadata: Record<string, unknown> = {};

      const rawHtml = await page.content();

      if (body.formats.includes("html")) {
        content.html = rawHtml;
      }

      if (body.formats.includes("text")) {
        content.text = await page.evaluate("document.body.innerText") as string;
      }

      const needsDefuddle =
        body.formats.includes("markdown") || body.formats.includes("readability");

      if (needsDefuddle) {
        const wantsMarkdown = body.formats.includes("markdown");
        const wantsReadability = body.formats.includes("readability");

        if (wantsReadability) {
          const defuddled = await extractWithDefuddle(rawHtml, page.url(), false);
          content.readability = defuddled.content;
          metadata = {
            title: defuddled.title,
            description: defuddled.description,
            author: defuddled.author,
            published: defuddled.published,
            language: defuddled.language,
            image: defuddled.image,
            favicon: defuddled.favicon,
            wordCount: defuddled.wordCount,
            site: defuddled.site,
          };
        }

        if (wantsMarkdown) {
          const mdResult = await extractWithDefuddle(rawHtml, page.url(), true);
          content.markdown = mdResult.content;
          if (!wantsReadability) {
            metadata = {
              title: mdResult.title,
              description: mdResult.description,
              author: mdResult.author,
              published: mdResult.published,
              language: mdResult.language,
              image: mdResult.image,
              favicon: mdResult.favicon,
              wordCount: mdResult.wordCount,
              site: mdResult.site,
            };
          }
        }
      }

      if (!needsDefuddle) {
        metadata = await page.evaluate(`({
          title: document.title,
          description: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
          author: document.querySelector('meta[name="author"]')?.getAttribute("content") ?? "",
          language: document.documentElement.lang ?? "",
        })`) as Record<string, unknown>;
      }

      const links = await page.evaluate(`
        Array.from(document.querySelectorAll("a[href]"))
          .map(a => ({ url: a.href, text: (a.textContent || "").trim() }))
          .filter(l => l.url && l.text)
      `) as Array<{ url: string; text: string }>;

      return { content, metadata, links };
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
