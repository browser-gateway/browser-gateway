import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, isAbsolute } from "node:path";

/**
 * Resolve `BG_DATA_DIR` to an absolute path. Chain (highest precedence first):
 *
 *   1. `BG_DATA_DIR` env var (Docker pins it to `/data`)
 *   2. `~/.browser-gateway` if `HOME` is set (global install, npx, dev laptop)
 *   3. `./data` relative to CWD (last-resort fallback)
 *
 * Creates the directory (with parents) and returns its absolute path. mode
 * 0700 — gateway state is not for other users on a shared host.
 */
export function resolveDataDir(): string {
  const fromEnv = process.env.BG_DATA_DIR;
  const candidate = fromEnv
    ? fromEnv
    : homedir()
    ? resolve(homedir(), ".browser-gateway")
    : resolve("./data");

  const absolute = isAbsolute(candidate) ? candidate : resolve(candidate);
  if (!existsSync(absolute)) {
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
  }
  return absolute;
}
