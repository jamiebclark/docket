import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (see Dockerfile).
  output: "standalone",
  // Migrations are read from disk at startup; trace them into the standalone output.
  outputFileTracingIncludes: { "/*": ["./drizzle/**/*"] },
  // The sign-up URL carries the invitation token: never leak it through the Referer header.
  async headers() {
    return [{ source: "/signup", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] }];
  },
};

export default nextConfig;
