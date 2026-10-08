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
 * Resolves true when this request was a problems view that marked read, so the page can tell the bell.
 */
export const ensureProblemsViewMarked = cache(async (): Promise<boolean> => {
  try {
    const h = await headers();
    if (isPrefetch(h)) return false;
    const path = h.get("x-docket-path");
    if (!path) return false;
    const url = new URL(path, "http://docket.invalid");
    const scope = problemsViewScope(url.pathname, url.searchParams);
    if (!scope) return false;
    const session = await getSession();
    if (!session) return false;
    await markProblemsView(await forMyProjects(session), scope);
    return true;
  } catch (error) {
    console.error("notifications: could not mark the problems view", error);
    return false;
  }
});
