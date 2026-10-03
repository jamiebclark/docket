import { ZodError } from "zod";
import { fail, failFromError, fieldErrorsFromZod, ok, type ActionResult } from "@/lib/action-result";
import { forProject, type ProjectScope } from "@/server/dal";
import { getSession } from "@/server/auth/session";

/**
 * Shared body of a project server action: resolve the scope (no session or non-member → `not_found`),
 * run `fn`, and turn thrown service errors into an `ActionResult` (contracts/ui.md).
 */
export async function runAction<T>(slug: string, fn: (scope: ProjectScope) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const scope = await forProject(await getSession(), slug);
    return ok(await fn(scope));
  } catch (error) {
    if (error instanceof ZodError) return fail("validation", "Check the highlighted fields.", fieldErrorsFromZod(error));
    return failFromError(error);
  }
}
