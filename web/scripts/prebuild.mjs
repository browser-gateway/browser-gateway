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

import { statSync } from "node:fs";

function syncTree(fromDir, toDir, extensions) {
  rmSync(toDir, { recursive: true, force: true });
  mkdirSync(toDir, { recursive: true });
  let count = 0;
  for (const entry of readdirSync(fromDir)) {
    const src = resolve(fromDir, entry);
    if (statSync(src).isDirectory()) continue;
    if (!extensions.some((ext) => entry.endsWith(ext))) continue;
    writeFileSync(resolve(toDir, entry), readFileSync(src));
    count++;
  }
  return count;
}

const liveClientSrc = resolve(PARENT_ROOT, "src", "live-client");
const liveClientDest = resolve(WEB_ROOT, "src", "vendor", "live-client");
const nLive = syncTree(liveClientSrc, liveClientDest, [".ts"]);
console.log(`[prebuild] synced ${nLive} files → src/vendor/live-client/`);

const providerFormDist = resolve(PARENT_ROOT, "dist", "provider-form");
const providerFormDest = resolve(WEB_ROOT, "src", "vendor", "provider-form");
try {
  statSync(providerFormDist);
} catch {
  throw new Error(
    `[prebuild] ${providerFormDist} missing — run \`npm run build\` in the gateway root first (produces dist/provider-form/).`,
  );
}
const nPF = syncTree(providerFormDist, providerFormDest, [".js", ".d.ts", ".map"]);
console.log(`[prebuild] synced ${nPF} files → src/vendor/provider-form/`);

// 2. Stamp parent version into web/version.json so next.config.ts reads it
//    from cwd instead of the parent dir.
const parentPkg = JSON.parse(readFileSync(resolve(PARENT_ROOT, "package.json"), "utf-8"));
writeFileSync(
  resolve(WEB_ROOT, "version.json"),
  JSON.stringify({ version: parentPkg.version }, null, 2) + "\n",
);
console.log(`[prebuild] stamped version → ${parentPkg.version}`);
