export const CREATE_PROJECT_HREF = "/p/new";

export type SwitcherProject = { slug: string; name: string };

export type SwitcherItem =
  | { kind: "project"; slug: string; label: string; href: string }
  | { kind: "create"; label: string; href: string };

/** Projects matching `filter` (name or slug, case-insensitive), then "Create project" always last. */
export function filterSwitcherItems(projects: SwitcherProject[], filter: string): SwitcherItem[] {
  const needle = filter.trim().toLowerCase();
  const items: SwitcherItem[] = projects
    .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.slug.toLowerCase().includes(needle))
    .map((p) => ({ kind: "project", slug: p.slug, label: p.name, href: `/p/${p.slug}` }));
  items.push({ kind: "create", label: "Create project", href: CREATE_PROJECT_HREF });
  return items;
}

/** Move the highlight by `delta`, wrapping at both ends; 0 for an empty list. */
export function moveHighlight(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((current + delta) % length) + length) % length;
}

/** Where Enter should go for the highlighted item, or null if nothing is highlighted. */
export function targetForHighlight(items: SwitcherItem[], index: number): string | null {
  return items[index]?.href ?? null;
}
