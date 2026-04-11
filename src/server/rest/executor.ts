import type { Page } from "playwright-core";
import type { Logger } from "pino";
import type { SessionPool } from "../../core/pool/index.js";
import { RestApiError } from "./schemas.js";

export interface PageOptions {
  url: string;
  viewport?: { width: number; height: number };
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  waitForSelector?: string;
  waitForTimeout?: number;
  timeout?: number;
  headers?: Record<string, string>;
  userAgent?: string;
  retries?: number;
  signal?: AbortSignal;
}

export interface PageResult<T> {
  data: T;
  statusCode: number | null;
  resolvedUrl: string;
  timings: {
    total: number;
    navigation: number;
    action: number;
  };
  attempt: number;
}

const NON_RETRYABLE_ERRORS = [
  "ERR_NAME_NOT_RESOLVED",
  "ERR_INVALID_URL",
  "ERR_CERT_",
  "ERR_SSL_",
  "Invalid URL",
  "Protocol error",
];

function isRetryable(error: string): boolean {
  return !NON_RETRYABLE_ERRORS.some((pattern) => error.includes(pattern));
}

export async function withBrowserPage<T>(
  pool: SessionPool,
  logger: Logger,
  options: PageOptions,
  action: (page: Page) => Promise<T>,
): Promise<PageResult<T>> {
  const startTime = Date.now();
  const maxAttempts = (options.retries ?? 2) + 1;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      logger.info({ attempt }, "rest: client disconnected, aborting");
      throw new RestApiError(499, "Client closed request");
    }

    let handle;

    try {
      handle = await pool.acquirePage();
    } catch {
      if (attempt < maxAttempts && !options.signal?.aborted) {
        logger.info({ attempt, maxAttempts }, "rest: pool acquire failed, retrying");
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      throw new RestApiError(503, "No browser sessions available");
    }

    try {
      const page = handle.page;

      if (options.viewport) {
        await page.setViewportSize(options.viewport);
      }
      if (options.headers) {
        await page.setExtraHTTPHeaders(options.headers);
      }

      const navStart = Date.now();
      const response = await page.goto(options.url, {
        waitUntil: options.waitUntil ?? "load",
        timeout: options.timeout ?? 30000,
      });
      const navEnd = Date.now();

      if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, { timeout: 10000 });
      }
      if (options.waitForTimeout) {
        await page.waitForTimeout(options.waitForTimeout);
      }

      const actionStart = Date.now();
      const data = await action(page);
      const actionEnd = Date.now();

      if (attempt > 1) {
        logger.info({ attempt, url: options.url }, "rest: succeeded on retry");
      }

      return {
        data,
        statusCode: response?.status() ?? null,
        resolvedUrl: page.url(),
        timings: {
          total: actionEnd - startTime,
          navigation: navEnd - navStart,
          action: actionEnd - actionStart,
        },
        attempt,
      };
    } catch (err) {
      lastError = err as Error;
      const message = lastError.message ?? "Unknown error";

      // Always release the page before retry — fresh page per attempt
      await pool.releasePage(handle).catch(() => {});

      // Don't retry non-retryable errors
      if (!isRetryable(message)) {
        logger.info({ attempt, error: message.slice(0, 100) }, "rest: non-retryable error");
        break;
      }

      if (attempt < maxAttempts && !options.signal?.aborted) {
        const delay = Math.min(500 * attempt, 2000);
        logger.info(
          { attempt, maxAttempts, error: message.slice(0, 80), delayMs: delay },
          "rest: retrying with fresh page",
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // Set handle to undefined so finally doesn't double-release
      handle = undefined as any;
    } finally {
      if (handle) {
        await pool.releasePage(handle).catch(() => {});
      }
    }
  }

  // All attempts exhausted
  const message = lastError?.message ?? "Unknown error";
  if (message.includes("Timeout") || message.includes("timeout")) {
    throw new RestApiError(408, `Navigation timeout after ${maxAttempts} attempts: ${message}`);
  }
  if (message.includes("503") || message.includes("unavailable")) {
    throw new RestApiError(503, `All providers unavailable after ${maxAttempts} attempts`);
  }
  throw new RestApiError(500, `Failed after ${maxAttempts} attempts: ${message}`);
}

export async function scrollThroughPage(page: Page): Promise<void> {
  await page.evaluate(`(async () => {
    const scrollStep = Math.floor(window.innerHeight / 2);
    await new Promise((resolve) => {
      function scrollDown() {
        window.scrollBy(0, scrollStep);
        if (
          document.body.scrollHeight -
            (window.pageYOffset + window.innerHeight) <
          scrollStep
        ) {
          window.scrollTo(0, 0);
          setTimeout(resolve, 500);
          return;
        }
        setTimeout(scrollDown, 100);
      }
      scrollDown();
    });
  })()`);
}
