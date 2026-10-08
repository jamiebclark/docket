"use server";

import { redirect } from "next/navigation";
import { fail, failFromError, ok, type ActionResult } from "@/lib/action-result";
import { getSession } from "@/server/auth/session";
import { forMyProjects, NotFoundError } from "@/server/dal";
import { markAllRead as markAllReadService, setNotificationsBySlug } from "@/server/services/notifications";

/** Only the Notifications page itself: an absolute URL, a protocol-relative one or any other path is ignored. */
function safeReturnTo(value: FormDataEntryValue | null): "/notifications" | null {
  return value === "/notifications" ? "/notifications" : null;
}

/** Marks every project's problems read. With `returnTo=/notifications` it redirects back; otherwise it returns the count and any busy projects. */
export async function markAllRead(
  _prev: ActionResult<{ count: number; busy: string[] }> | null,
  formData: FormData,
): Promise<ActionResult<{ count: number; busy: string[] }>> {
  const session = await getSession();
  if (!session) redirect("/login?next=/notifications");
  const returnTo = safeReturnTo(formData.get("returnTo"));
  let busy: string[];
  let count: number;
  try {
    const set = await forMyProjects(session);
    ({ busy } = await markAllReadService(set));
    count = await set.notifications.countUnread();
  } catch (error) {
    return failFromError(error);
  }
  if (returnTo) redirect(`${returnTo}?marked=1${busy.length > 0 ? `&busy=${encodeURIComponent(busy.join(","))}` : ""}`);
  return ok({ count, busy });
}

/** Turns one project's notifications on or off, then returns to the page with a confirmation. */
export async function setNotifications(_prev: ActionResult<never> | null, formData: FormData): Promise<ActionResult<never>> {
  const session = await getSession();
  if (!session) redirect("/login?next=/notifications");
  const projectSlug = String(formData.get("projectSlug") ?? "");
  try {
    await setNotificationsBySlug(await forMyProjects(session), { projectSlug, on: String(formData.get("on") ?? "") });
  } catch (error) {
    if (error instanceof NotFoundError) return fail("not_found", "That project could not be found.");
    return failFromError(error);
  }
  redirect(`/notifications?changed=${encodeURIComponent(projectSlug)}`);
}
