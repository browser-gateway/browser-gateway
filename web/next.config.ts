import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  distDir: "dist",
  basePath: "/web",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
