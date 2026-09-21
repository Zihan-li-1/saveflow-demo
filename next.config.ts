import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The demo is fully client-side and can be published as static files.
  output: "export",
  trailingSlash: true,
};

export default nextConfig;
