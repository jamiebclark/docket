"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { fail, failFromError, type ActionResult } from "@/lib/action-result";
import { getAuth } from "@/server/auth/auth";
import * as setup from "@/server/services/setup";

/** Creates the first account, signs in, and goes to project creation. Returns only on failure. */
export async function completeSetup(
  _prev: ActionResult<never> | null,
  formData: FormData,
): Promise<ActionResult<never>> {
  const input = {
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
  };
  let email: string;
  try {
    ({ email } = await setup.createFirstUser(input));
  } catch (error) {
    if (error instanceof ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of error.issues) {
        const key = String(issue.path[0] ?? "form");
        fieldErrors[key] ??= issue.message;
      }
      return fail("validation", "Check the highlighted fields.", fieldErrors);
    }
    const result = failFromError(error);
    if (result.ok === false && result.error === "setup_unavailable") redirect("/login");
    return result;
  }
  try {
    await getAuth().api.signInEmail({ body: { email, password: input.password }, headers: await headers() });
  } catch {
    redirect("/login"); // The account exists; sign-in can be retried by hand.
  }
  redirect("/p/new");
}
