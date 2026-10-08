// When does opening a page count as "viewing the problems"? Pure, so the rule is testable without a server (research R7, R9).
import { knownPlatformKeys } from "../activity";
import { parseActivityFilter, type RawParams } from "../activity/filters";

export type ProblemsViewScope = { kind: "project"; slug: string } | { kind: "all"; slugs: string[] | null };

// Any of these, even malformed, means the person is looking at something narrower or further along than "the problems".
const DISQUALIFYING = ["platform", "account", "range", "from", "to", "before", "after", "cursor"] as const;

const PROJECT_ACTIVITY = /^\/p\/([^/]+)\/activity$/;

function rawParams(search: URLSearchParams): RawParams {
  const raw: RawParams = {};
  for (const key of new Set(search.keys())) {
    const all = search.getAll(key);
    raw[key] = all.length === 1 ? all[0] : all;
  }
  return raw;
}

/** Non-null exactly for `/p/{slug}/activity` or `/activity` showing only the problems preset: no other filter, no page cursor. */
export function problemsViewScope(pathname: string, search: URLSearchParams): ProblemsViewScope | null {
  const project = PROJECT_ACTIVITY.exec(pathname);
  if (!project && pathname !== "/activity") return null;
  if (DISQUALIFYING.some((key) => search.has(key))) return null;
  const raw = rawParams(search);
  const { filter } = parseActivityFilter(raw, { mode: "lenient", allowProjects: pathname === "/activity", knownPlatforms: knownPlatformKeys() });
  if (filter.preset !== "problems" || filter.invalidRange) return null;
  if (project) {
    try {
      return { kind: "project", slug: decodeURIComponent(project[1]!) };
    } catch {
      return null;
    }
  }
  return { kind: "all", slugs: filter.projectSlugs };
}

/** Browser speculation and framework prefetches must never mark anything read. */
export function isPrefetch(headers: Headers): boolean {
  if (headers.has("next-router-prefetch") || headers.has("next-router-segment-prefetch")) return true;
  return ["sec-purpose", "purpose"].some((name) => (headers.get(name) ?? "").toLowerCase().includes("prefetch"));
}
