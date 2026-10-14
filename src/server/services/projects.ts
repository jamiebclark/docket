import { z } from "zod";
import {
  approvalPolicySchema,
  brandDescriptionSchema,
  brandWebsiteSchema,
  CONFIRM_UNREVIEWED_QUEUE_MESSAGE,
  projectNameSchema,
  schedulingPolicySchema,
  slugSchema,
  taglineSchema,
  timeZoneSchema,
} from "@/lib/validation";
import { createProject, getProject, listMyProjects } from "../dal/projects";
import type { ProjectScope, SessionLike } from "../dal/scope";
import { ForbiddenError, NotFoundError } from "../dal/errors";
import { recordAudit } from "./audit";

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
  confirmUnreviewedQueue: z.boolean().default(false),
  tagline: taglineSchema.optional(),
  description: brandDescriptionSchema.optional(),
  websiteUrl: brandWebsiteSchema.optional(),
});

const BRAND_FIELDS = ["tagline", "description", "websiteUrl"] as const;

/** Owner/admin only. Throws ZodError, ForbiddenError, or ConflictError (field `slug`). */
export async function updateSettings(scope: ProjectScope, input: unknown): Promise<{ slug: string }> {
  if (!scope.can({ project: ["update"] })) throw new ForbiddenError();
  const { confirmUnreviewedQueue, ...parsed } = updateSettingsSchema.parse(input);
  if (parsed.defaultApprovalPolicy === "auto_approve" && parsed.defaultSchedulingPolicy === "add_to_queue" && !confirmUnreviewedQueue) {
    throw new z.ZodError([
      { code: "custom", path: ["confirmUnreviewedQueue"], message: CONFIRM_UNREVIEWED_QUEUE_MESSAGE, input: undefined },
    ]);
  }
  // A key submitted as an explicit `undefined` still survives `.optional()`'s parse, so `in` is not a
  // safe test for "the caller meant to change this" — only a defined value belongs in the patch.
  const patch = { ...parsed };
  for (const field of BRAND_FIELDS) {
    if (patch[field] === undefined) delete patch[field];
  }
  const project = await scope.transaction(
    async (tx) => {
      if (!tx.can({ project: ["update"] })) throw new ForbiddenError();
      const before = await tx.projects.get();
      const updated = await tx.projects.update(patch);
      for (const field of BRAND_FIELDS) {
        if (field in patch && before && patch[field] !== before[field]) {
          await recordAudit(tx, {
            action: "project_brand_update",
            actorUserId: tx.membership.userId || null,
            details: { field, previous: before[field], next: patch[field] },
          });
        }
      }
      return updated;
    },
    { lockProject: true },
  );
  return { slug: project.slug };
}
