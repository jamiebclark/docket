"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { fail, failFromError, fieldErrorsFromZod, ok, type ActionResult } from "@/lib/action-result";
import { forProject, NotFoundError, NotificationsBusyError } from "@/server/dal";
import type { MuteErrorCode } from "@/lib/notifications/text";
import { getSession } from "@/server/auth/session";
import * as notifications from "@/server/services/notifications";
import * as projects from "@/server/services/projects";

/** Saves project settings. A slug change redirects to the new URL (the proxy cookie follows it). */
export async function updateProjectSettings(
  _prev: ActionResult<{ saved: true }> | null,
  formData: FormData,
): Promise<ActionResult<{ saved: true }>> {
  const current = String(formData.get("currentSlug") ?? "");
  let slug: string;
  try {
    const session = await getSession();
    if (!session) redirect(`/login?next=${encodeURIComponent(`/p/${current}/settings`)}`);
    const scope = await forProject(session, current);
    ({ slug } = await projects.updateSettings(scope, {
      name: String(formData.get("name") ?? ""),
      slug: String(formData.get("slug") ?? ""),
      timezone: String(formData.get("timezone") ?? ""),
      defaultApprovalPolicy: String(formData.get("defaultApprovalPolicy") ?? ""),
      defaultSchedulingPolicy: String(formData.get("defaultSchedulingPolicy") ?? ""),
      confirmUnreviewedQueue: formData.get("confirmUnreviewedQueue") === "on",
    }));
  } catch (error) {
    if (error instanceof ZodError) return fail("validation", "Check the highlighted fields.", fieldErrorsFromZod(error));
    return failFromError(error);
  }
  if (slug !== current) redirect(`/p/${slug}/settings`);
  revalidatePath(`/p/${slug}`, "layout");
  return ok({ saved: true });
}

/** Turns the caller's own notifications for this project on or off. Any role may. */
export async function setMyProjectNotifications(_prev: ActionResult<never> | null, formData: FormData): Promise<ActionResult<never>> {
  const slug = String(formData.get("projectSlug") ?? "");
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/p/${slug}/settings`)}`);
  let on = false;
  let failed: MuteErrorCode | null = null;
  try {
    const scope = await forProject(session, slug);
    ({ on } = await notifications.setMyProjectNotifications(scope, { on: String(formData.get("on") ?? "") }));
  } catch (error) {
    if (error instanceof NotFoundError) failed = "not_found";
    else if (error instanceof NotificationsBusyError) failed = "busy";
    else if (error instanceof ZodError) failed = "invalid";
    else return failFromError(error);
  }
  if (failed) redirect(`/p/${slug}/settings?notifications=${failed}`);
  redirect(`/p/${slug}/settings?notifications=${on ? "on" : "off"}`);
}
