"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { fail, failFromError, fieldErrorsFromZod, ok, type ActionResult } from "@/lib/action-result";
import { forProject } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { checkProjectLlm, type LlmCheckResult } from "@/server/services/generation/check";
import { removeProjectLlm, saveProjectLlm, type ProjectLlmView } from "@/server/services/generation/credential";

async function scopeFor(slug: string) {
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/p/${slug}/settings/model`)}`);
  return forProject(session, slug);
}

const refresh = (slug: string) => revalidatePath(`/p/${slug}/settings/model`);

export async function saveProjectModel(
  _prev: ActionResult<ProjectLlmView> | null,
  formData: FormData,
): Promise<ActionResult<ProjectLlmView>> {
  const slug = String(formData.get("slug") ?? "");
  try {
    const scope = await scopeFor(slug);
    const view = await saveProjectLlm(scope, {
      provider: String(formData.get("provider") ?? ""),
      model: String(formData.get("model") ?? ""),
      apiKey: String(formData.get("apiKey") ?? ""),
    });
    refresh(slug);
    return ok(view);
  } catch (error) {
    if (error instanceof ZodError) return fail("validation", "Check the highlighted fields.", fieldErrorsFromZod(error));
    return failFromError(error);
  }
}

export async function removeProjectModel(
  _prev: ActionResult<ProjectLlmView> | null,
  formData: FormData,
): Promise<ActionResult<ProjectLlmView>> {
  const slug = String(formData.get("slug") ?? "");
  try {
    const scope = await scopeFor(slug);
    const view = await removeProjectLlm(scope);
    refresh(slug);
    return ok(view);
  } catch (error) {
    return failFromError(error);
  }
}

export async function checkProjectModel(
  _prev: ActionResult<LlmCheckResult> | null,
  formData: FormData,
): Promise<ActionResult<LlmCheckResult>> {
  const slug = String(formData.get("slug") ?? "");
  try {
    const scope = await scopeFor(slug);
    return ok(await checkProjectLlm(scope));
  } catch (error) {
    return failFromError(error);
  }
}
