"use server";

import { redirect } from "next/navigation";
import { failFromError, type ActionResult } from "@/lib/action-result";
import { getSession } from "@/server/auth/session";
import * as invitations from "@/server/services/invitations";

async function sessionOrLogin() {
  const session = await getSession();
  if (!session) redirect("/login?next=/invitations");
  return { user: { id: session.user.id, email: session.user.email } };
}

/** Accepts one of the signed-in user's invitations and opens the project. Returns only on failure. */
export async function acceptInvitation(
  _prev: ActionResult<never> | null,
  formData: FormData,
): Promise<ActionResult<never>> {
  const session = await sessionOrLogin();
  let slug: string;
  try {
    ({ slug } = await invitations.acceptById(session, { invitationId: String(formData.get("invitationId") ?? "") }));
  } catch (error) {
    return failFromError(error);
  }
  redirect(`/p/${slug}`);
}

/** Declines the invitation and reloads the list. Returns only on failure. */
export async function declineInvitation(
  _prev: ActionResult<never> | null,
  formData: FormData,
): Promise<ActionResult<never>> {
  const session = await sessionOrLogin();
  try {
    await invitations.declineById(session, { invitationId: String(formData.get("invitationId") ?? "") });
  } catch (error) {
    return failFromError(error);
  }
  redirect("/invitations");
}
