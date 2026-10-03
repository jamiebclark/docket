"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { fail, failFromError, fieldErrorsFromZod, type ActionResult } from "@/lib/action-result";
import { getAuth } from "@/server/auth/auth";
import { getSession } from "@/server/auth/session";
import * as invitations from "@/server/services/invitations";

const tokenOf = (formData: FormData) => String(formData.get("token") ?? "");

/** Creates the invited account, signs it in and opens the project. Returns only on failure. */
export async function signUpWithInvitation(
  _prev: ActionResult<never> | null,
  formData: FormData,
): Promise<ActionResult<never>> {
  const password = String(formData.get("password") ?? "");
  let result: { email: string; slug: string };
  try {
    result = await invitations.signUp({ token: tokenOf(formData), name: String(formData.get("name") ?? ""), password });
  } catch (error) {
    if (error instanceof ZodError) return fail("validation", "Check the highlighted fields.", fieldErrorsFromZod(error));
    return failFromError(error);
  }
  try {
    await getAuth().api.signInEmail({ body: { email: result.email, password }, headers: await headers() });
  } catch {
    redirect("/login"); // The account exists; signing in can be retried by hand.
  }
  redirect(`/p/${result.slug}`);
}

async function signedIn(token: string) {
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/signup?token=${token}`)}`);
  return { user: { id: session.user.id, email: session.user.email } };
}

export async function acceptInvitationByToken(
  _prev: ActionResult<never> | null,
  formData: FormData,
): Promise<ActionResult<never>> {
  const token = tokenOf(formData);
  const session = await signedIn(token);
  let slug: string;
  try {
    ({ slug } = await invitations.acceptByToken(session, { token }));
  } catch (error) {
    return failFromError(error);
  }
  redirect(`/p/${slug}`);
}

export async function declineInvitationByToken(
  _prev: ActionResult<never> | null,
  formData: FormData,
): Promise<ActionResult<never>> {
  const token = tokenOf(formData);
  const session = await signedIn(token);
  try {
    await invitations.declineByToken(session, { token });
  } catch (error) {
    return failFromError(error);
  }
  redirect("/");
}
