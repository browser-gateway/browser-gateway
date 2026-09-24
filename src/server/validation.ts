import type { z } from "zod";
import { redactConnectionUrl, redactHeaders } from "../core/redact.js";
import {
  GatewayConfigSchema,
  ProviderConfigSchema,
  WebhookSchema,
  type GatewayConfig,
  type ProviderConfig,
} from "../core/types.js";

/**
 * Format a Zod error into a human-readable list of "path: message" strings.
 * Used by every REST handler that does `safeParse`. Extracted so the error
 * format stays consistent across endpoints.
 */
export function formatZodErrors(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

/**
 * Restore the stored secret when the caller echoed back a masked value.
 * `GET /v1/providers` redacts URLs and header values, so an edit form that
 * round-trips its own view would otherwise persist the mask.
 */
function unmaskAgainstExisting(
  url: string | undefined,
  headers: Record<string, string> | null | undefined,
  existing: ProviderConfig | undefined,
): { url: string | undefined; headers: Record<string, string> | null | undefined } {
  if (!existing) return { url, headers };
  const nextUrl = url !== undefined && url === redactConnectionUrl(existing.url) ? existing.url : url;
  if (!headers) return { url: nextUrl, headers };
  const masked = redactHeaders(existing.headers);
  const nextHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const stored = existing.headers?.[key];
    nextHeaders[key] = stored !== undefined && value === masked[key] ? stored : value;
  }
  return { url: nextUrl, headers: nextHeaders };
}

/**
 * Parse a provider config body (from POST or PUT /v1/providers/...).
 *
 * @param body         raw JSON body from the request
 * @param existing     existing provider config (PUT only — used to merge)
 * @returns            either parsed ProviderConfig data or formatted error
 */
export function parseProviderConfigBody(
  body: Record<string, unknown>,
  existing?: ProviderConfig,
): { data: ProviderConfig; errors?: undefined } | { data?: undefined; errors: string[] } {
  const raw = unmaskAgainstExisting(
    body.url as string | undefined,
    body.headers as Record<string, string> | null | undefined,
    existing,
  );
  const url = raw.url;
  const maxConcurrent = body.maxConcurrent as number | undefined;
  const priority = body.priority as number | undefined;
  const weight = body.weight as number | undefined;
  const profile = body.profile as string | null | undefined;
  const multiProfile = body.multiProfile as boolean | undefined;
  const enabled = body.enabled as boolean | undefined;
  const headers = raw.headers;

  const candidate = {
    url: url ?? existing?.url,
    limits: maxConcurrent !== undefined
      ? { maxConcurrent }
      : existing?.limits,
    priority: priority ?? existing?.priority ?? 1,
    weight: weight ?? existing?.weight ?? 1,
    profile: profile === null ? undefined : (profile ?? existing?.profile),
    multiProfile: multiProfile ?? existing?.multiProfile ?? false,
    headers: headers === null ? undefined : (headers ?? existing?.headers),
    enabled: enabled ?? existing?.enabled,
  };

  const parsed = ProviderConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    return { errors: formatZodErrors(parsed.error) };
  }
  return { data: parsed.data };
}

/** Validate a webhook request body against {@link WebhookSchema}. */
export function parseWebhookBody(
  body: Record<string, unknown>,
): { data: { url: string; events?: string[] }; errors?: undefined } | { data?: undefined; errors: string[] } {
  const parsed = WebhookSchema.safeParse(body);
  if (!parsed.success) {
    return { errors: formatZodErrors(parsed.error) };
  }
  return { data: parsed.data };
}

/**
 * Parse a YAML string and validate it against {@link GatewayConfigSchema}.
 *
 * Returns one of three discriminated outcomes:
 *   - parse error (invalid YAML)
 *   - validation error (well-formed YAML but invalid structure)
 *   - success (valid config)
 */
export async function parseYamlGatewayConfig(yaml: string): Promise<
  | { kind: "parse-error"; message: string }
  | { kind: "validation-error"; errors: string[] }
  | { kind: "ok"; data: GatewayConfig }
> {
  const { parse } = await import("yaml");
  let parsed: unknown;
  try {
    parsed = parse(yaml);
  } catch (err) {
    return { kind: "parse-error", message: (err as Error).message };
  }
  const result = GatewayConfigSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: "validation-error", errors: formatZodErrors(result.error) };
  }
  return { kind: "ok", data: result.data };
}
