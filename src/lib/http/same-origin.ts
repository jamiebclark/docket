export type SameOriginRefusal = "origin_mismatch" | "cross_site_fetch" | "missing_origin";

export interface SameOriginInput {
  method: string;
  pathname: string;
  headers: Headers;
  /** `new URL(BETTER_AUTH_URL).origin` */
  appOrigin: string;
  sessionCookiePresent: boolean;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether a state-changing request comes from the app's own origin (FR-021, contracts/http-security.md §1). */
export function checkSameOrigin(input: SameOriginInput): { ok: true } | { ok: false; reason: SameOriginRefusal } {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };
  // Bearer-authenticated surfaces never use cookies, so there is nothing to forge.
  if (input.pathname.startsWith("/api/v1/") || input.pathname === "/api/internal/tick") return { ok: true };

  const origin = input.headers.get("origin");
  if (origin !== null) {
    return origin === input.appOrigin ? { ok: true } : { ok: false, reason: "origin_mismatch" };
  }
  const site = input.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return { ok: false, reason: "cross_site_fetch" };
  return input.sessionCookiePresent ? { ok: false, reason: "missing_origin" } : { ok: true };
}
