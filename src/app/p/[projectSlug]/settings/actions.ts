"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { fail, failFromError, fieldErrorsFromZod, ok, type ActionResult } from "@/lib/action-result";
import { forProject } from "@/server/dal";
import { getSession } from "@/server/auth/session";
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
