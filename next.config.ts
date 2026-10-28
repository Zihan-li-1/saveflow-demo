import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Local `next dev` must keep the Node runtime so /api/banking-agent can run.
  // Static export remains available for the old fixture-only deployment path.
  ...(process.env.SAVEFLOW_STATIC_EXPORT === "true" ? { output: "export" as const } : {}),
  trailingSlash: process.env.SAVEFLOW_STATIC_EXPORT === "true",
};

export default nextConfig;
