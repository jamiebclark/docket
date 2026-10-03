"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { fail, failFromError, fieldErrorsFromZod, ok, type ActionResult } from "@/lib/action-result";
import { forProject } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as invitations from "@/server/services/invitations";
import * as members from "@/server/services/members";

/** The one-time link shown after invite or regenerate. `null` when delivery was in-app. */
export type DeliveryDto = { invitationId: string; link: { url: string; expiresAt: string } | null };

function toDto(result: invitations.CreateResult): DeliveryDto {
  return {
    invitationId: result.invitationId,
    link:
      result.delivery.kind === "manual_link"
        ? { url: result.delivery.url, expiresAt: result.delivery.expiresAt.toISOString() }
        : null,
  };
}

async function scopeFor(slug: string) {
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/p/${slug}/settings/members`)}`);
  return forProject(session, slug);
}

const slugOf = (formData: FormData) => String(formData.get("slug") ?? "");
const refresh = (slug: string) => revalidatePath(`/p/${slug}/settings/members`);

export async function inviteMember(
  _prev: ActionResult<DeliveryDto> | null,
  formData: FormData,
): Promise<ActionResult<DeliveryDto>> {
  const slug = slugOf(formData);
  try {
    const scope = await scopeFor(slug);
    const result = await invitations.create(scope, {
      email: String(formData.get("email") ?? ""),
      role: String(formData.get("role") ?? ""),
    });
    refresh(slug);
    return ok(toDto(result));
  } catch (error) {
    if (error instanceof ZodError) return fail("validation", "Check the highlighted fields.", fieldErrorsFromZod(error));
    return failFromError(error);
  }
}

export async function regenerateInvitation(
  _prev: ActionResult<DeliveryDto> | null,
  formData: FormData,
): Promise<ActionResult<DeliveryDto>> {
  const slug = slugOf(formData);
  try {
    const scope = await scopeFor(slug);
    const result = await invitations.regenerate(scope, { invitationId: String(formData.get("invitationId") ?? "") });
    refresh(slug);
    return ok(toDto(result));
  } catch (error) {
    return failFromError(error);
  }
}

export async function revokeInvitation(
  _prev: ActionResult<DeliveryDto> | null,
  formData: FormData,
): Promise<ActionResult<DeliveryDto>> {
  const slug = slugOf(formData);
  try {
    const scope = await scopeFor(slug);
    await invitations.revoke(scope, { invitationId: String(formData.get("invitationId") ?? "") });
    refresh(slug);
    return ok({ invitationId: String(formData.get("invitationId") ?? ""), link: null });
  } catch (error) {
    return failFromError(error);
  }
}

const userIdOf = (formData: FormData) => String(formData.get("userId") ?? "");

export async function changeMemberRole(
  _prev: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  const slug = slugOf(formData);
  try {
    const scope = await scopeFor(slug);
    await members.changeRole(scope, { userId: userIdOf(formData), role: String(formData.get("role") ?? "") });
    refresh(slug);
    return ok(null);
  } catch (error) {
    if (error instanceof ZodError) return fail("validation", "Choose a role.", fieldErrorsFromZod(error));
    return failFromError(error);
  }
}

export async function removeMember(
  _prev: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  const slug = slugOf(formData);
  try {
    const scope = await scopeFor(slug);
    await members.remove(scope, { userId: userIdOf(formData) });
    refresh(slug);
    return ok(null);
  } catch (error) {
    if (error instanceof ZodError) return fail("not_found", "Not found.");
    return failFromError(error);
  }
}

export async function transferOwnership(
  _prev: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  const slug = slugOf(formData);
  try {
    const scope = await scopeFor(slug);
    await members.transferOwnership(scope, { userId: userIdOf(formData) });
    refresh(slug);
    return ok(null);
  } catch (error) {
    if (error instanceof ZodError) return fail("not_found", "Not found.");
    return failFromError(error);
  }
}

export async function leaveProject(
  _prev: ActionResult<null> | null,
  formData: FormData,
): Promise<ActionResult<null>> {
  const slug = slugOf(formData);
  try {
    const scope = await scopeFor(slug);
    await members.leave(scope);
  } catch (error) {
    return failFromError(error);
  }
  redirect("/");
}
