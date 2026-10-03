// Pure decision logic for src/proxy.ts (FR-013). Optimistic only: it checks that a
// session cookie is present, never that it is valid — pages and actions re-check.

const PUBLIC_EXACT = new Set(["/login", "/setup", "/signup"]);
const PUBLIC_PREFIXES = ["/api/auth/", "/api/health", "/_next/", "/favicon.ico"];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  if (pathname === "/api/auth") return true;
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
