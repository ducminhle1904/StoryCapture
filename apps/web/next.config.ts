import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@storycapture/shared-types", "@storycapture/ui"],
  serverExternalPackages: ["@maxmind/geoip2-node"],
};

export default nextConfig;
