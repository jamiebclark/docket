import type { ProjectLlmView } from "@/server/services/generation/credential";

/** The view as the client sees it. Dates are ISO strings. */
export interface ProjectLlmDto extends Omit<ProjectLlmView, "lastChange"> {
  lastChange: { by: { id: string; name: string } | null; at: string } | null;
}

export function toModelDto(v: ProjectLlmView): ProjectLlmDto {
  return {
    ...v,
    lastChange: v.lastChange ? { by: v.lastChange.by, at: v.lastChange.at.toISOString() } : null,
  };
}
