import { getSession } from "@/server/auth/session";
import { forMyProjects } from "@/server/dal";
import { unreadSummary } from "@/server/services/notifications";

export const dynamic = "force-dynamic";

// Session cookie only, no input: a parameter naming another user or project has no effect (FR-015).
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie", "Content-Type": "application/json" };

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

/** The refresh behind the header bell. */
export async function GET(): Promise<Response> {
  try {
    const session = await getSession();
    if (!session) return reply({ error: "unauthenticated" }, 401);
    return reply(await unreadSummary(await forMyProjects(session)));
  } catch (error) {
    console.error("notifications: refresh failed", error);
    return reply({ error: "unavailable" }, 500);
  }
}
