import type { NextConfig } from "next";

/**
 * Next.js production configuration.
 *
 * - Standalone output for Vercel deployment
 * - Monorepo transpile packages
 * - Security headers (T-04-34: X-Frame-Options, CSP)
 * - Image domain for R2 public URL
 */
const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@storycapture/shared-types", "@storycapture/ui"],
  serverExternalPackages: ["@maxmind/geoip2-node"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.r2.cloudflarestorage.com",
      },
      {
        protocol: "https",
        hostname: "*.r2.dev",
      },
    ],
  },
  async headers() {
    return [
      {
        // Security headers for all non-embed pages
        source: "/((?!embed/).*)",
        headers: [
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
          {
            key: "X-DNS-Prefetch-Control",
            value: "on",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
      {
        // Embed pages allow framing (for iframe embeds per D-03)
        source: "/embed/:path*",
        headers: [
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
