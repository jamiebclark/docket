// Pure decision logic for src/proxy.ts (FR-013). Optimistic only: it checks that a
// session cookie is present, never that it is valid — pages and actions re-check.

// The manifest is fetched without cookies by browsers installing the app, so it must not redirect.
//
// Both unsubscribe routes are public for the same reason, and it is the point of them: somebody acting
// on an unwanted email is routinely not signed in, and RFC 8058's one-click POST is sent by the mail
// client itself, with no cookies at all. Redirecting either to /login makes unsubscribing impossible
// for exactly the people who need it. Their credential is the encrypted, scoped, expiring token in `t`,
// which `readUnsubscribeToken` verifies — a session would prove nothing extra (045/044, FR-026).
const PUBLIC_EXACT = new Set([
  "/login",
  "/setup",
  "/signup",
  "/manifest.webmanifest",
  "/email/unsubscribe",
  "/api/email/unsubscribe",
]);
const PUBLIC_PREFIXES = ["/api/auth/", "/api/health", "/api/internal/", "/api/me/", "/api/v1/", "/_next/", "/favicon.ico"];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  if (pathname === "/api/auth" || pathname === "/api/v1") return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

/** Returns the `/login?next=…` target for an unauthenticated request, or null to let it through. */
export function loginRedirectFor(
  pathname: string,
  search: string,
  hasSession: boolean,
): string | null {
  if (hasSession || isPublicPath(pathname)) return null;
  const next = pathname === "/" && !search ? "" : `?next=${encodeURIComponent(pathname + search)}`;
  return `/login${next}`;
}

/** Slug to remember as the last project for `/p/<slug>` and `/p/<slug>/…`; null for `/p/new` and everything else. */
export function lastProjectSlugFor(pathname: string): string | null {
  const match = /^\/p\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match || match[1] === "new") return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}
