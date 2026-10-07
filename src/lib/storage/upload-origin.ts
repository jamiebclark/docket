/**
 * The origin a browser sends upload parts to, for the CSP `connect-src` (research P6). A pure function of
 * the storage settings; the test proves it equals the origin of the SDK's own presigned `UploadPart` URL.
 */

export interface UploadOriginInput {
  bucket: string;
  region: string;
  endpoint?: string;
  browserEndpoint?: string;
  forcePathStyle: boolean;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Virtual-hosted addressing needs a DNS-compatible bucket and a host name, not an IP address. */
function isVirtualHosted(input: UploadOriginInput, host: string): boolean {
  if (input.forcePathStyle) return false;
  if (host.startsWith("[") || IPV4.test(host)) return false;
  return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.bucket);
}

export function uploadOrigin(input: UploadOriginInput): string {
  const endpoint = input.browserEndpoint || input.endpoint;
  if (!endpoint) {
    const host = `s3.${input.region}.amazonaws.com`;
    return `https://${isVirtualHosted(input, host) ? `${input.bucket}.` : ""}${host}`;
  }
  const u = new URL(endpoint);
  const host = isVirtualHosted(input, u.hostname) ? `${input.bucket}.${u.host}` : u.host;
  return `${u.protocol}//${host}`;
}

/** The origin for the process environment; null when storage is unset or the transport is `via_app`. */
export function uploadOriginFromEnv(env: Record<string, string | undefined>): string | null {
  const bucket = env.S3_BUCKET?.trim();
  if (!bucket) return null;
  if (env.MEDIA_UPLOAD_TRANSPORT === "via_app") return null;
  try {
    return uploadOrigin({
      bucket,
      region: env.S3_REGION?.trim() || "auto",
      endpoint: env.S3_ENDPOINT?.trim() || undefined,
      browserEndpoint: env.S3_BROWSER_ENDPOINT?.trim() || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    });
  } catch {
    return null;
  }
}
