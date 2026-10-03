import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hasSessionCookie, lastProjectSlugFor, loginRedirectFor } from "@/lib/auth-gate";

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const target = loginRedirectFor(
    pathname,
    search,
    hasSessionCookie((name) => request.cookies.has(name)),
  );
  if (target) return NextResponse.redirect(new URL(target, request.url));
  const response = NextResponse.next();
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
