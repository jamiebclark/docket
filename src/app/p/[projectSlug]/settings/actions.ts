"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { fail, failFromError, fieldErrorsFromZod, ok, type ActionResult } from "@/lib/action-result";
import { forProject, NotFoundError, NotificationsBusyError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as notifications from "@/server/services/notifications";
import * as projects from "@/server/services/projects";

/** Saves project settings. A slug change redirects to the new URL (the proxy cookie follows it). */
export async function updateProjectSettings(
  _prev: ActionResult<{ saved: true }> | null,
  formData: FormData,
): Promise<ActionResult<{ saved: true }>> {
  const current = String(formData.get("currentSlug") ?? "");
  const maybe = (name: string) => (formData.has(name) ? String(formData.get(name) ?? "") : undefined);
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
      tagline: maybe("tagline"),
      description: maybe("description"),
      websiteUrl: maybe("websiteUrl"),
    }));
  } catch (error) {
    if (error instanceof ZodError) return fail("validation", "Check the highlighted fields.", fieldErrorsFromZod(error));
    return failFromError(error);
  }
  if (slug !== current) redirect(`/p/${slug}/settings`);
  revalidatePath(`/p/${slug}`, "layout");
  return ok({ saved: true });
}

/** Turns one of the caller's own kind, platform or project-level switches for this project. Any role may. */
export async function setMyProjectNotifications(_prev: ActionResult<never> | null, formData: FormData): Promise<ActionResult<never>> {
  const slug = String(formData.get("projectSlug") ?? "");
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/p/${slug}/settings`)}`);
  let failed: "busy" | "not_found" | "invalid" | null = null;
  let qs = "";
  try {
    const scope = await forProject(session, slug);
    const change = await notifications.setMySwitchForProject(scope, {
      axis: formData.get("axis"),
      key: formData.get("key") ?? undefined,
      on: formData.get("on"),
    });
    const params = new URLSearchParams({ changed: "1", axis: change.axis });
    if (change.key !== undefined) params.set("key", change.key);
    params.set("on", change.on ? "1" : "0");
    qs = params.toString();
  } catch (error) {
    if (error instanceof NotFoundError) failed = "not_found";
    else if (error instanceof NotificationsBusyError) failed = "busy";
    else if (error instanceof ZodError) failed = "invalid";
    else return failFromError(error);
  }
  if (failed) redirect(`/p/${slug}/settings?notifications=${failed}`);
  redirect(`/p/${slug}/settings?${qs}`);
}
