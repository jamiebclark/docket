"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { fail, failFromError, fieldErrorsFromZod, ok, type ActionResult } from "@/lib/action-result";
import { forProject } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as webhooks from "@/server/services/webhooks";
import { toEndpointDto, type EndpointDto } from "./dto";

async function scopeFor(slug: string) {
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/p/${slug}/settings/webhooks`)}`);
  return forProject(session, slug);
}

const refresh = (slug: string) => revalidatePath(`/p/${slug}/settings/webhooks`, "layout");

const endpointInput = (formData: FormData) => ({
  url: String(formData.get("url") ?? ""),
  description: String(formData.get("description") ?? ""),
  events: formData.getAll("events").map(String),
});

function failed(error: unknown) {
  if (error instanceof ZodError) return fail("validation", "Check the highlighted fields.", fieldErrorsFromZod(error));
  return failFromError(error);
}

/** The secret is in the return value only: it is never logged, stored or put in the URL. */
export async function createEndpointAction(
  slug: string,
  formData: FormData,
): Promise<ActionResult<{ secret: string; endpoint: EndpointDto; httpWarning: boolean }>> {
  try {
    const { endpoint, secret, httpWarning } = await webhooks.createEndpoint(await scopeFor(slug), endpointInput(formData));
    refresh(slug);
    return ok({ secret, endpoint: toEndpointDto(endpoint), httpWarning });
  } catch (error) {
    return failed(error);
  }
}

export async function updateEndpointAction(slug: string, id: string, formData: FormData): Promise<ActionResult<EndpointDto>> {
  try {
    const endpoint = await webhooks.updateEndpoint(await scopeFor(slug), id, endpointInput(formData));
    refresh(slug);
    return ok(toEndpointDto(endpoint));
  } catch (error) {
    return failed(error);
  }
}

export async function setEndpointEnabledAction(slug: string, id: string, enabled: boolean): Promise<ActionResult<null>> {
  try {
    await webhooks.setEndpointEnabled(await scopeFor(slug), id, enabled);
    refresh(slug);
    return ok(null);
  } catch (error) {
    return failed(error);
  }
}

export async function deleteEndpointAction(slug: string, id: string): Promise<ActionResult<null>> {
  try {
    await webhooks.deleteEndpoint(await scopeFor(slug), id);
    refresh(slug);
    return ok(null);
  } catch (error) {
    return failed(error);
  }
}

export async function rotateSecretAction(slug: string, id: string): Promise<ActionResult<{ secret: string }>> {
  try {
    const result = await webhooks.rotateSecret(await scopeFor(slug), id);
    refresh(slug);
    return ok(result);
  } catch (error) {
    return failed(error);
  }
}

export async function resendDeliveryAction(slug: string, deliveryId: string): Promise<ActionResult<null>> {
  try {
    await webhooks.resendDelivery(await scopeFor(slug), deliveryId);
    refresh(slug);
    return ok(null);
  } catch (error) {
    return failed(error);
  }
}

export async function sendTestEventAction(slug: string, endpointId: string): Promise<ActionResult<null>> {
  try {
    await webhooks.sendTestEvent(await scopeFor(slug), endpointId);
    refresh(slug);
    return ok(null);
  } catch (error) {
    return failed(error);
  }
}
