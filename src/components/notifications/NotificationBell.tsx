import { NotificationBellClient } from "@/components/notifications/NotificationBellClient";
import { ensureProblemsViewMarked } from "@/components/notifications/request";
import type { UnreadSummary } from "@/lib/notifications/types";
import { getSession } from "@/server/auth/session";
import { forMyProjects } from "@/server/dal";
import { unreadSummary } from "@/server/services/notifications";

const NONE: UnreadSummary = { count: 0, display: "", label: "Notifications" };

/** The header bell with the person's unread count. A failure here never fails the page: the bell just shows no count. */
export async function NotificationBell() {
  let summary = NONE;
  try {
    await ensureProblemsViewMarked();
    const session = await getSession();
    if (session) summary = await unreadSummary(await forMyProjects(session));
  } catch (error) {
    console.error("notifications: could not count unread problems", error);
  }
  return <NotificationBellClient initial={summary} />;
}
