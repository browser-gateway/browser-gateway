import type { Page } from "playwright-core";
import type { Logger } from "pino";
import type { Gateway } from "../../core/index.js";
import type { SessionPool } from "../../core/pool/index.js";
import type { ProfileLifecycle } from "../profile/lifecycle.js";
import { ContentRequestSchema } from "./schemas.js";
import { dispatchPageAction } from "./dispatch.js";
import { extractFormats, pageOptionsFromBody } from "./rest-helpers.js";
import type { Context } from "hono";

interface ContentData {
  content: Record<string, string>;
  metadata: Record<string, unknown>;
  links: Array<{ url: string; text: string }>;
}

export async function handleContent(
  c: Context,
  pool: SessionPool,
  gateway: Gateway,
  logger: Logger,
  profileLifecycle?: ProfileLifecycle,
) {
  const body = ContentRequestSchema.parse(await c.req.json());

  const result = await dispatchPageAction(
    { pool, gateway, logger, profileLifecycle },
    body.profile,
    pageOptionsFromBody(body, c),
    async (page: Page): Promise<ContentData> => {
      const rawHtml = await page.content();
      const { content, metadata: defuddleMetadata } = await extractFormats(
        rawHtml,
        page.url(),
        () => page.evaluate("document.body.innerText") as Promise<string>,
        body.formats,
      );

      // If neither markdown nor readability was requested, fall back to a tiny
      // metadata snapshot pulled directly from the page.
      const metadata: Record<string, unknown> = defuddleMetadata
        ?? (await page.evaluate(`({
          title: document.title,
          description: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
          author: document.querySelector('meta[name="author"]')?.getAttribute("content") ?? "",
          language: document.documentElement.lang ?? "",
        })`) as Record<string, unknown>);

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
