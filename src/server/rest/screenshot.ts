import type { Page } from "playwright-core";
import type { Logger } from "pino";
import type { Gateway } from "../../core/index.js";
import type { SessionPool } from "../../core/pool/index.js";
import type { ProfileLifecycle } from "../profile/lifecycle.js";
import { ScreenshotRequestSchema, RestApiError } from "./schemas.js";
import { scrollThroughPage } from "./executor.js";
import { dispatchPageAction } from "./dispatch.js";
import { pageOptionsFromBody } from "./rest-helpers.js";
import type { Context } from "hono";

export async function handleScreenshot(
  c: Context,
  pool: SessionPool,
  gateway: Gateway,
  logger: Logger,
  profileLifecycle?: ProfileLifecycle,
) {
  const body = ScreenshotRequestSchema.parse(await c.req.json());

  const result = await dispatchPageAction(
    { pool, gateway, logger, profileLifecycle },
    body.profile,
    pageOptionsFromBody(body, c),
    async (page: Page) => {
      if (body.scrollPage) {
        await scrollThroughPage(page);
      }

      if (body.selector) {
        const element = await page.$(body.selector);
        if (!element) {
          throw new RestApiError(400, `Selector "${body.selector}" not found on page`);
        }
        return element.screenshot({
          type: body.format,
          quality: body.format === "jpeg" ? (body.quality ?? 80) : undefined,
          omitBackground: body.omitBackground,
        });
      }

      return page.screenshot({
        fullPage: body.fullPage,
        type: body.format,
        quality: body.format === "jpeg" ? (body.quality ?? 80) : undefined,
        clip: body.clip,
        omitBackground: body.omitBackground,
      });
    },
  );

  return new Response(result.data, {
    status: 200,
    headers: {
      "Content-Type": `image/${body.format}`,
      "X-Response-Code": String(result.statusCode ?? ""),
      "X-Response-URL": result.resolvedUrl,
      "X-Timing-Total-Ms": String(result.timings.total),
      "X-Timing-Navigation-Ms": String(result.timings.navigation),
    },
  });
}
