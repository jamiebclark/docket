import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/server/auth/session";
import { getEnv } from "@/server/env";
import { handleOAuthCallback } from "@/server/services/connect";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const base = getEnv().BETTER_AUTH_URL;
  const go = (path: string) => NextResponse.redirect(new URL(path, base));
  const session = await getSession();
  if (!session) {
    // Signed-out callbacks are sent to sign-in; the session that returns will not match the attempt's, so it is refused (D6).
    return go(`/login?next=${encodeURIComponent(`/connect/callback${request.nextUrl.search}`)}`);
  }
  const outcome = await handleOAuthCallback(request.nextUrl.searchParams, {
    userId: session.user.id,
    sessionId: session.session.id,
  });
  switch (outcome.kind) {
    case "chooser":
      return go(`/p/${outcome.projectSlug}/accounts/connect/${outcome.attemptId}`);
    case "accounts":
      return go(`/p/${outcome.projectSlug}/accounts?connect=${outcome.code}&group=${encodeURIComponent(outcome.groupKey)}`);
    default:
      return go("/connect/invalid");
  }
}
