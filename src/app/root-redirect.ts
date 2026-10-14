export type RootRedirectProject = { slug: string; name: string; joinedAt: Date };

/**
 * Where "/" sends a signed-in user (FR-018): the remembered project if they
 * are still a member, else their earliest-joined project, else project creation.
 */
export function decideRootRedirect(lastSlug: string | undefined, projects: RootRedirectProject[]): string {
  if (lastSlug && projects.some((p) => p.slug === lastSlug)) return `/p/${lastSlug}`;
  const earliest = [...projects].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0];
  return earliest ? `/p/${earliest.slug}` : "/p/new";
}

/**
 * Where an anonymous visitor to "/" or "/login" goes: a fresh install with no
 * account yet is sent to the first-account screen. Otherwise null — they stay
 * put, and "/" shows the public description of the installation (with its
 * "Log in" link) rather than redirecting, so platform reviewers can read it.
 */
export function decideAnonymousRedirect(setupAvailable: boolean): "/setup" | null {
  return setupAvailable ? "/setup" : null;
}
