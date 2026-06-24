import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(
  readFileSync(resolve(process.cwd(), "..", "package.json"), "utf-8"),
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
