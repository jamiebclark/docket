import { z } from "zod";
import {
  approvalPolicySchema,
  projectNameSchema,
  schedulingPolicySchema,
  slugSchema,
  timeZoneSchema,
} from "@/lib/validation";
import { createProject, getProject, listMyProjects } from "../dal/projects";
import type { ProjectScope, SessionLike } from "../dal/scope";
import { ForbiddenError, NotFoundError } from "../dal/errors";

export const createProjectSchema = z.object({
  name: projectNameSchema,
  slug: slugSchema,
  timezone: timeZoneSchema,
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
  defaultApprovalPolicy: approvalPolicySchema,
  defaultSchedulingPolicy: schedulingPolicySchema,
});

/** Owner/admin only. Throws ZodError, ForbiddenError, or ConflictError (field `slug`). */
export async function updateSettings(scope: ProjectScope, input: unknown): Promise<{ slug: string }> {
  if (!scope.can({ project: ["update"] })) throw new ForbiddenError();
  const patch = updateSettingsSchema.parse(input);
  const project = await scope.transaction(
    (tx) => {
      if (!tx.can({ project: ["update"] })) throw new ForbiddenError();
      return tx.projects.update(patch);
    },
    { lockProject: true },
  );
  return { slug: project.slug };
}
