import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import { getSession } from "@/server/auth/session";
import { forMyProjects } from "@/server/dal";
import { markProblemsView } from "@/server/services/notifications";
import { isPrefetch, problemsViewScope } from "@/server/services/notifications/view-mark";

/**
 * Viewing the Problems list marks it read, and the header count must already reflect that, so the page and the
 * bell both call this first. Once per request; never throws; a prefetch or any other URL marks nothing.
 */
export const ensureProblemsViewMarked = cache(async (): Promise<void> => {
  try {
    const h = await headers();
    if (isPrefetch(h)) return;
    const path = h.get("x-docket-path");
    if (!path) return;
    const url = new URL(path, "http://docket.invalid");
    const scope = problemsViewScope(url.pathname, url.searchParams);
    if (!scope) return;
    const session = await getSession();
    if (!session) return;
    await markProblemsView(await forMyProjects(session), scope);
  } catch (error) {
    console.error("notifications: could not mark the problems view", error);
  }
});
