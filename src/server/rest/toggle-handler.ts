import { resolve } from "node:path";
import type { Context } from "hono";
import { loadedConfigPath } from "../config/loader.js";
import type { GatewayConfig } from "../../core/types.js";

export type ToggleFlow<R> = (input: { configPath: string; config: GatewayConfig }) => R;

export function makeToggleHandler<R>(
  getConfig: () => GatewayConfig | undefined,
  flow: ToggleFlow<R>,
  missingConfigError: string,
  failureLabel: string,
) {
  return async (c: Context) => {
    const config = getConfig();
    if (!config) {
      return c.json({ error: missingConfigError }, 400);
    }
    try {
      const result = flow({
        configPath: loadedConfigPath ?? resolve(process.cwd(), "gateway.yml"),
        config,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : failureLabel }, 400);
    }
  };
}
