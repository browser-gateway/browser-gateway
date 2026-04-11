import { z } from "zod";

const ViewportSchema = z.object({
  width: z.number().int().min(1).max(3840).default(1280),
  height: z.number().int().min(1).max(2160).default(720),
});

const WaitUntilSchema = z.enum(["load", "domcontentloaded", "networkidle", "commit"]);

const BaseFields = {
  url: z.string().url(),
  viewport: ViewportSchema.optional(),
  waitForSelector: z.string().optional(),
  waitForTimeout: z.number().int().min(0).max(30000).optional(),
  timeout: z.number().int().min(1000).max(60000).default(30000),
  retries: z.number().int().min(0).max(5).default(2),
  headers: z.record(z.string(), z.string()).optional(),
  userAgent: z.string().optional(),
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
  waitUntil: WaitUntilSchema.default("load"),
}).strict();

export type ScreenshotRequest = z.infer<typeof ScreenshotRequestSchema>;

const ContentFormatSchema = z.enum(["html", "markdown", "text", "readability"]);

export const ContentRequestSchema = z.object({
  ...BaseFields,
  formats: z.array(ContentFormatSchema).min(1).default(["markdown"]),
  waitUntil: WaitUntilSchema.default("domcontentloaded"),
}).strict();

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
