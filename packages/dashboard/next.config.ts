import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@aitne/shared"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
          },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: "/cost", destination: "/analytics", permanent: true },
      { source: "/metrics", destination: "/analytics?tab=metrics", permanent: true },
      { source: "/logs", destination: "/activity", permanent: true },
      { source: "/conversations", destination: "/activity?tab=conversations", permanent: true },
      { source: "/approvals", destination: "/", permanent: true },
    ];
  },
};

export default nextConfig;
