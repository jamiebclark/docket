// The mail client's one-click path (contracts/http.md §2). POST only — the page at /email/unsubscribe
// is the human-facing target, so a GET here is 405. No session, no CSRF token; the body is read by
// nobody and ignored entirely. Every outcome, valid or refused, is `204` with no body (FR-029, E23).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { applyUnsubscribe } from "@/server/services/email";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = request.nextUrl.searchParams.get("t");
  await applyUnsubscribe(token, { kind: "all_off" }, new Date());
  return new NextResponse(null, { status: 204 });
}

export async function GET(): Promise<NextResponse> {
  return new NextResponse(null, { status: 405 });
}
