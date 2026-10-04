import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { lastProjectSlugFor, loginRedirectFor } from "@/lib/auth-gate";
import { checkSameOrigin } from "@/lib/http/same-origin";
import { buildCsp, newNonce, securityHeaders } from "@/lib/http/security-headers";
import { listConnectGroups } from "@/providers/registry";

const appUrl = () => process.env.BETTER_AUTH_URL?.trim() || "http://localhost:3000";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

let oauthOriginsCache: string[] | undefined;
/** Where each connect group sends the browser to authorise; the only places a form may post to besides us. */
function oauthOrigins(): string[] {
  if (oauthOriginsCache) return oauthOriginsCache;
  const origins = new Set<string>();
  for (const entry of listConnectGroups()) {
    try {
      const origin = originOf(entry.group.authorizationUrl({ state: "x", redirectUri: appUrl() }));
      if (origin) origins.add(origin);
    } catch {
      // A group that is not configured has no authorisation address to allow.
    }
  }
  return (oauthOriginsCache = [...origins]);
}

function publicMediaOrigin(): string | null {
  const base = process.env.S3_PUBLIC_BASE_URL?.trim();
  return base ? originOf(base) : null;
}

function applySecurity(response: NextResponse, headers: Record<string, string>): NextResponse {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = getSessionCookie(request) !== null;

  const verdict = checkSameOrigin({
    method: request.method,
    pathname,
    headers: request.headers,
    appOrigin: originOf(appUrl()) ?? "http://localhost:3000",
    sessionCookiePresent: hasSession,
  });
  // Refused before anything runs, so the request has no effect. The reason is not revealed.
  if (!verdict.ok) {
    return NextResponse.json({ error: "cross_origin" }, { status: 403, headers: { "cache-control": "no-store" } });
  }

  const nonce = newNonce();
  const csp = buildCsp({
    nonce,
    dev: process.env.NODE_ENV !== "production",
    publicMediaOrigin: publicMediaOrigin(),
    oauthOrigins: oauthOrigins(),
  });
  const headers = securityHeaders({ appUrl: appUrl(), csp });

  const target = loginRedirectFor(pathname, search, hasSession);
  if (target) return applySecurity(NextResponse.redirect(new URL(target, request.url)), headers);

  // Next reads the nonce from the request's CSP header while rendering.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = applySecurity(NextResponse.next({ request: { headers: requestHeaders } }), headers);
  const slug = lastProjectSlugFor(pathname);
  if (slug) {
    response.cookies.set("docket_last_project", slug, {
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return response;
}

export const config = {
  // Static assets and image optimisation never need a session.
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:ico|png|jpg|jpeg|svg|webp|gif|txt|woff2?)$).*)"],
};
