import type { NextConfig } from "next";

// Request-body ceiling for photo/video uploads: the largest upload (MEDIA_MAX_UPLOAD_MB, up to 25)
// plus multipart overhead. Applies to Server Actions and to bodies buffered through the proxy.
export const UPLOAD_BODY_LIMIT = "26mb";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (see Dockerfile).
  output: "standalone",
  // Migrations are read from disk at startup; trace them into the standalone output.
  outputFileTracingIncludes: { "/*": ["./drizzle/**/*"] },
  experimental: {
    serverActions: { bodySizeLimit: UPLOAD_BODY_LIMIT },
    proxyClientMaxBodySize: UPLOAD_BODY_LIMIT,
  },
  // The sign-up URL carries the invitation token: never leak it through the Referer header.
  async headers() {
    return [{ source: "/signup", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] }];
  },
};

export default nextConfig;
