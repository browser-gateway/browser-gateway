#!/usr/bin/env node
// Materialises everything web/ needs from the parent tree into web/-local paths
// so the web workspace has zero cross-boundary reads at build time.
// Runs automatically via npm predev / prebuild lifecycle hooks.
// See: fixes Docker web-builder stage isolation (v0.4.14).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, "..");
const PARENT_ROOT = resolve(WEB_ROOT, "..");

// 1. Sync src/live-client/*.ts into web/src/vendor/live-client/
const src = resolve(PARENT_ROOT, "src", "live-client");
const dest = resolve(WEB_ROOT, "src", "vendor", "live-client");
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const file of readdirSync(src)) {
  if (!file.endsWith(".ts")) continue;
  writeFileSync(resolve(dest, file), readFileSync(resolve(src, file)));
}
console.log(`[prebuild] synced ${readdirSync(dest).length} files → src/vendor/live-client/`);

// 2. Stamp parent version into web/version.json so next.config.ts reads it
//    from cwd instead of the parent dir.
const parentPkg = JSON.parse(readFileSync(resolve(PARENT_ROOT, "package.json"), "utf-8"));
writeFileSync(
  resolve(WEB_ROOT, "version.json"),
  JSON.stringify({ version: parentPkg.version }, null, 2) + "\n",
);
console.log(`[prebuild] stamped version → ${parentPkg.version}`);
