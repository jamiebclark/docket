"use server";

import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { fail, failFromError, type ActionResult } from "@/lib/action-result";
import { getSession } from "@/server/auth/session";
import * as projects from "@/server/services/projects";

/** Creates a project and opens it. Returns only on failure. */
export async function createProject(
  _prev: ActionResult<never> | null,
  formData: FormData,
): Promise<ActionResult<never>> {
  const session = await getSession();
  if (!session) redirect("/login?next=/p/new");
  let slug: string;
  try {
    ({ slug } = await projects.create(session, {
      name: String(formData.get("name") ?? ""),
      slug: String(formData.get("slug") ?? ""),
      timezone: String(formData.get("timezone") ?? ""),
    }));
  } catch (error) {
    if (error instanceof ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of error.issues) fieldErrors[String(issue.path[0] ?? "form")] ??= issue.message;
      return fail("validation", "Check the highlighted fields.", fieldErrors);
    }
    return failFromError(error);
  }
  redirect(`/p/${slug}`);
}
