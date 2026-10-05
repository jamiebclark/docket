import { notFound } from "next/navigation";
import { findProvider } from "@/providers/registry";
import { forProject, NotFoundError, type ProjectScope } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import type { AccountOption } from "./VoiceEditor";

/** The caller's scope for this project, or the project's not-found page. */
export async function scopeOrNotFound(slug: string): Promise<ProjectScope> {
  try {
    return await forProject(await getSession(), slug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}

/** The project's accounts as Try it options, in list order. */
export async function accountOptions(scope: ProjectScope): Promise<AccountOption[]> {
  return (await scope.accounts.list()).map((a) => ({
    id: a.id,
    displayName: a.displayName,
    providerKey: a.providerKey,
    providerName: findProvider(a.providerKey)?.displayName ?? a.providerKey,
    postingInstructions: a.postingInstructions,
  }));
}
