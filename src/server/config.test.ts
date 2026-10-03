import { describe, expect, it } from "vitest";
import nextConfig, { UPLOAD_BODY_LIMIT } from "../../next.config";

const MAX_UPLOAD_MB = 25;
const MULTIPART_OVERHEAD_MB = 1;

function megabytes(limit: unknown): number {
  const match = /^(\d+(?:\.\d+)?)\s*mb$/i.exec(String(limit));
  if (!match) throw new Error(`unexpected size limit: ${String(limit)}`);
  return Number(match[1]);
}

describe("next.config upload limits", () => {
  it("raises the server action body limit above the max upload plus overhead", () => {
    const limit = nextConfig.experimental?.serverActions?.bodySizeLimit;
    expect(limit).toBe(UPLOAD_BODY_LIMIT);
    expect(megabytes(limit)).toBeGreaterThanOrEqual(MAX_UPLOAD_MB + MULTIPART_OVERHEAD_MB);
  });

  it("raises the proxy client body limit above the max upload plus overhead", () => {
    const limit = nextConfig.experimental?.proxyClientMaxBodySize;
    expect(limit).toBe(UPLOAD_BODY_LIMIT);
    expect(megabytes(limit)).toBeGreaterThanOrEqual(MAX_UPLOAD_MB + MULTIPART_OVERHEAD_MB);
  });
});
