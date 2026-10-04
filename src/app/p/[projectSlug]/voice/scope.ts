import { notFound } from "next/navigation";
import { listProviders } from "@/providers/registry";
import { forProject, NotFoundError, type ProjectScope } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import type { PlatformOption } from "./VoiceEditor";

/** The caller's scope for this project, or the project's not-found page. */
export async function scopeOrNotFound(slug: string): Promise<ProjectScope> {
  try {
    return await forProject(await getSession(), slug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}

export const platformOptions = (): PlatformOption[] =>
  listProviders().map((p) => ({ key: p.key, displayName: p.displayName }));

/** Providers of connected accounts, in registry order; Try it starts with these ticked. */
export async function connectedProviderKeys(scope: ProjectScope): Promise<string[]> {
  const used = new Set((await scope.accounts.list()).map((a) => a.providerKey));
  return platformOptions().map((p) => p.key).filter((k) => used.has(k));
}
