import { createHash, createHmac } from "node:crypto";

/**
 * The PKCE verifier is derived from the attempt's `state` rather than stored (research D1):
 * base64url(HMAC-SHA256(secret, "docket:x:pkce:v1:" + state)), 43 characters.
 */
export function pkceVerifier(state: string, secret: string): string {
  return createHmac("sha256", secret).update(`docket:x:pkce:v1:${state}`).digest("base64url");
}

/** S256 challenge: base64url(SHA-256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
