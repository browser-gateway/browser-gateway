import type { z } from "zod";
import {
  GatewayConfigSchema,
  ProviderConfigSchema,
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
  const url = body.url as string | undefined;
  const maxConcurrent = body.maxConcurrent as number | undefined;
  const priority = body.priority as number | undefined;
  const weight = body.weight as number | undefined;

  const candidate = {
    url: url ?? existing?.url,
    limits: maxConcurrent !== undefined
      ? { maxConcurrent }
      : existing?.limits,
    priority: priority ?? existing?.priority ?? 1,
    weight: weight ?? existing?.weight ?? 1,
  };

  const parsed = ProviderConfigSchema.safeParse(candidate);
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
