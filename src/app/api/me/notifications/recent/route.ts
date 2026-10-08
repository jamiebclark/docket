import { getSession } from "@/server/auth/session";
import { forMyProjects } from "@/server/dal";
import { recentPanel } from "@/server/services/notifications";

export const dynamic = "force-dynamic";

// Session cookie only, no input: a parameter naming another user or project has no effect (FR-015).
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie", "Content-Type": "application/json" };

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

/** The panel behind the header bell: up to 10 newest problems from projects with notifications on. */
export async function GET(): Promise<Response> {
  try {
    const session = await getSession();
    if (!session) return reply({ error: "unauthenticated" }, 401);
    return reply(await recentPanel(await forMyProjects(session), new Date()));
  } catch (error) {
    console.error("notifications: panel failed", error);
    return reply({ error: "unavailable" }, 500);
  }
}
