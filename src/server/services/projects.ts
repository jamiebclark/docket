import { z } from "zod";
import { createProject, getProject, listMyProjects } from "../dal/projects";
import type { ProjectScope, SessionLike } from "../dal/scope";
import { ForbiddenError, NotFoundError } from "../dal/errors";

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const slugSchema = z
  .string()
  .trim()
  .min(2, "Use at least 2 characters")
  .max(40, "Use 40 characters or fewer")
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens")
  .refine((s) => s !== "new", "That URL name is reserved");

export const timezoneSchema = z
  .string()
  .trim()
  .min(1, "Choose a time zone")
  .refine(isValidTimeZone, "Choose a valid time zone");

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(100, "Use 100 characters or fewer"),
  slug: slugSchema,
  timezone: timezoneSchema,
});

/** Throws ZodError for bad input and ConflictError (field `slug`) for a taken slug. */
export async function create(session: SessionLike, input: unknown): Promise<{ slug: string }> {
  const parsed = createProjectSchema.parse(input);
  const project = await createProject(session.user.id, parsed);
  return { slug: project.slug };
}

export async function listMine(session: SessionLike) {
  return listMyProjects(session.user.id);
}

export async function get(scope: ProjectScope) {
  const project = await getProject(scope.project.id);
  if (!project) throw new NotFoundError();
  return { ...project, canEdit: scope.can({ project: ["update"] }) };
}

export const updateSettingsSchema = createProjectSchema.extend({
  defaultApprovalPolicy: z.enum(["review_required", "auto_approve"], { error: "Choose an approval policy" }),
  defaultSchedulingPolicy: z.enum(["leave_as_draft", "add_to_queue"], { error: "Choose a scheduling policy" }),
});

/** Owner/admin only. Throws ZodError, ForbiddenError, or ConflictError (field `slug`). */
export async function updateSettings(scope: ProjectScope, input: unknown): Promise<{ slug: string }> {
  if (!scope.can({ project: ["update"] })) throw new ForbiddenError();
  const patch = updateSettingsSchema.parse(input);
  const project = await scope.transaction((tx) => tx.projects.update(patch), { lockProject: true });
  return { slug: project.slug };
}
