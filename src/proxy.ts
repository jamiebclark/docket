import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hasSessionCookie, loginRedirectFor } from "@/lib/auth-gate";

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const target = loginRedirectFor(
    pathname,
    search,
    hasSessionCookie((name) => request.cookies.has(name)),
  );
  if (!target) return NextResponse.next();
  return NextResponse.redirect(new URL(target, request.url));
}

export const config = {
  // Static assets and image optimisation never need a session.
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:ico|png|jpg|jpeg|svg|webp|gif|txt|woff2?)$).*)"],
};
