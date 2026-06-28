import { z } from "zod";

const ViewportSchema = z.object({
  width: z.number().int().min(1).max(3840).default(1280),
  height: z.number().int().min(1).max(2160).default(720),
});

const WaitUntilSchema = z.enum(["load", "domcontentloaded", "networkidle", "commit"]);

// Mirror of PROFILE_ID_REGEX from src/core/profile/types.ts — duplicated here
// so the REST layer doesn't need to pull in the whole profile module just to
// validate a request field. If the regex source ever changes, this is the
// other place to update.
const ProfileIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/, {
    message: "profile id must start with a letter or number and only contain letters, numbers, dots, dashes, underscores (max 128 chars)",
  });

const BaseFields = {
  url: z.string().url(),
  viewport: ViewportSchema.optional(),
  waitForSelector: z.string().optional(),
  waitForTimeout: z.number().int().min(0).max(30000).optional(),
  timeout: z.number().int().min(1000).max(60000).default(30000),
  retries: z.number().int().min(0).max(5).default(2),
  headers: z.record(z.string(), z.string()).optional(),
  userAgent: z.string().optional(),
  /**
   * Optional profile id. When set, the request acquires a profile lock,
   * injects the stored cookies into the chosen provider, runs the action,
   * captures the latest cookies on success, and releases the lock. Disables
   * automatic retries (one-shot — retries could double-commit state). Requires
   * the `profiles` feature to be enabled on the gateway.
   */
  profile: ProfileIdSchema.optional(),
  /**
   * Pin this request to a specific provider id (matches a key under
   * `providers:` in gateway.yml). When set, the gateway routes only to that
   * backend — no failover. Returns 400 if the id isn't configured, 503 if
   * the provider is in cooldown / saturated past `connectionTimeout`, and
   * 400 if `profile` is also set but the provider's `browserCookies`
   * capability is unsupported.
   */
  provider: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, { message: "provider id must be alphanumeric with hyphens or underscores" })
    .optional(),
};

export const ScreenshotRequestSchema = z.object({
  ...BaseFields,
  fullPage: z.boolean().default(false),
  format: z.enum(["png", "jpeg"]).default("png"),
  quality: z.number().int().min(0).max(100).optional(),
  selector: z.string().optional(),
  clip: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .optional(),
  omitBackground: z.boolean().default(false),
  scrollPage: z.boolean().default(false),
  waitUntil: WaitUntilSchema.default("domcontentloaded"),
}).strict();

/** Request body for `POST /v1/screenshot`. Inferred from {@link ScreenshotRequestSchema}. @public */
export type ScreenshotRequest = z.infer<typeof ScreenshotRequestSchema>;

const ContentFormatSchema = z.enum(["html", "markdown", "text", "readability"]);

export const ContentRequestSchema = z.object({
  ...BaseFields,
  formats: z.array(ContentFormatSchema).min(1).default(["markdown"]),
  waitUntil: WaitUntilSchema.default("domcontentloaded"),
}).strict();

/** Request body for `POST /v1/content`. Inferred from {@link ContentRequestSchema}. @public */
export type ContentRequest = z.infer<typeof ContentRequestSchema>;

const SelectorEntrySchema = z.object({
  name: z.string(),
  selector: z.string(),
  attribute: z.string().optional(),
}).strict();

export const ScrapeRequestSchema = z.object({
  ...BaseFields,
  selectors: z.array(SelectorEntrySchema).optional(),
  formats: z.array(ContentFormatSchema).optional(),
  screenshot: z.boolean().default(false),
  waitUntil: WaitUntilSchema.default("domcontentloaded"),
}).strict().refine(
  (d) => (d.selectors && d.selectors.length > 0) || (d.formats && d.formats.length > 0),
  { message: "Either 'selectors' or 'formats' (or both) must be provided" },
);

/** Request body for `POST /v1/scrape`. Inferred from {@link ScrapeRequestSchema}. @public */
export type ScrapeRequest = z.infer<typeof ScrapeRequestSchema>;

export class RestApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "RestApiError";
  }
}
