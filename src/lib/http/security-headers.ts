export interface CspInput {
  nonce: string;
  dev: boolean;
  /** Origin of the public media store when it is plain `http:` (local MinIO), else null. */
  publicMediaOrigin: string | null;
  oauthOrigins: readonly string[];
  /** Origin browsers send upload parts to (direct transport), else null. */
  uploadOrigin: string | null;
}

/** The Content-Security-Policy for one request (FR-024, contracts/http-security.md §2). */
export function buildCsp(input: CspInput): string {
  const img = ["'self'", "data:", "blob:", "https:"];
  if (input.publicMediaOrigin?.startsWith("http:")) img.push(input.publicMediaOrigin);
  const media = ["'self'", "blob:", "https:"];
  if (input.publicMediaOrigin?.startsWith("http:")) media.push(input.publicMediaOrigin);
  const connect = ["'self'"];
  if (input.uploadOrigin) connect.push(input.uploadOrigin);
  const script = ["'self'", `'nonce-${input.nonce}'`, "'strict-dynamic'"];
  if (input.dev) script.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${img.join(" ")}`,
    `media-src ${media.join(" ")}`,
    "font-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    `form-action ${["'self'", ...input.oauthOrigins].join(" ")}`,
  ].join("; ");
}

/** A fresh nonce: base64 of 16 random bytes. */
export function newNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/** Headers added by the proxy on every response. HSTS only goes out when the public URL is https. */
export function securityHeaders(input: { appUrl: string; csp: string }): Record<string, string> {
  const headers: Record<string, string> = { "Content-Security-Policy": input.csp };
  if (input.appUrl.startsWith("https://")) headers["Strict-Transport-Security"] = "max-age=31536000";
  return headers;
}
