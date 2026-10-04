"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { fail, failFromError, fieldErrorsFromZod, ok, type ActionResult } from "@/lib/action-result";
import { forProject } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as apiKeys from "@/server/services/api-keys";
import { toKeyDto, type ApiKeyDto } from "./dto";

async function scopeFor(slug: string) {
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/p/${slug}/settings/api-keys`)}`);
  return forProject(session, slug);
}

const refresh = (slug: string) => revalidatePath(`/p/${slug}/settings/api-keys`);

/** The secret is in the return value only: it is never logged, stored or put in the URL. */
export async function createApiKeyAction(
  slug: string,
  formData: FormData,
): Promise<ActionResult<{ secret: string; key: ApiKeyDto }>> {
  try {
    const scope = await scopeFor(slug);
    const { key, secret } = await apiKeys.createApiKey(scope, {
      name: String(formData.get("name") ?? ""),
      permissions: formData.getAll("permissions").map(String),
      rateLimitPerMinute: String(formData.get("rateLimitPerMinute") ?? "60"),
      expiry: String(formData.get("expiry") ?? "never"),
    });
    refresh(slug);
    return ok({ secret, key: toKeyDto(key) });
  } catch (error) {
    if (error instanceof ZodError) return fail("validation", "Check the highlighted fields.", fieldErrorsFromZod(error));
    return failFromError(error);
  }
}

export async function revokeApiKeyAction(
  slug: string,
  id: string,
): Promise<ActionResult<{ revoked: boolean; message?: string }>> {
  try {
    const scope = await scopeFor(slug);
    const result = await apiKeys.revokeApiKey(scope, id);
    refresh(slug);
    return ok(result.revoked ? { revoked: true } : { revoked: false, message: result.message });
  } catch (error) {
    return failFromError(error);
  }
}
