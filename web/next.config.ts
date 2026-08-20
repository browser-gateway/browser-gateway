import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// version.json is written by scripts/prebuild.mjs from the parent package.json.
// Keeps this config within the web/ workspace boundary — no ".." reads.
const pkg = JSON.parse(
  readFileSync(resolve(process.cwd(), "version.json"), "utf-8"),
) as { version: string };

const nextConfig: NextConfig = {
  output: "export",
  distDir: "dist",
  basePath: "/web",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
};

export default nextConfig;
