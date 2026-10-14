import type { ApiProject } from "@/lib/api/schemas";
import { CreateProjectRequestSchema, ProjectSchema } from "@/lib/api/schemas";
import { create } from "../../services/projects";
import type { ProjectRecord } from "../../dal/projects";
import { standardErrors } from "./errors-doc";
import { defineOperation } from "./types";

function toProject(project: ProjectRecord): ApiProject {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    timezone: project.timezone,
    defaultApprovalPolicy: project.defaultApprovalPolicy,
    defaultSchedulingPolicy: project.defaultSchedulingPolicy,
    tagline: project.tagline,
    description: project.description,
    websiteUrl: project.websiteUrl,
  };
}

const example = {
  id: "6f1c0f6e-2a21-4c51-9a93-1a1f0b7c8d20",
  slug: "playupnext",
  name: "Up Next",
  timezone: "America/New_York",
  defaultApprovalPolicy: "review_required",
  defaultSchedulingPolicy: "add_to_queue",
  tagline: "Board games, explained in a minute.",
  description: "Short, friendly explainers for modern board games.",
  websiteUrl: "https://playupnext.live",
};

export const projectOperations = [
  defineOperation({
    id: "createProject",
    method: "POST",
    path: "/projects",
    permission: "manage_setup",
    tag: "Projects",
    summary: "Create a project",
    description:
      "Creates a project with the calling key's creator as owner. Requires the `manage_setup` permission. Only `name`, `slug` and `timezone` are required; an omitted policy or brand field leaves the project's own default.",
    body: {
      kind: "json",
      schema: CreateProjectRequestSchema,
      examples: { create: { summary: "Create a project", value: { name: example.name, slug: example.slug, timezone: example.timezone } } },
    },
    responses: {
      201: { description: "Created", schema: ProjectSchema, examples: { created: { summary: "Created", value: example } } },
      ...standardErrors("manage_setup"),
    },
    idempotent: true,
    idempotencyMode: "self_commit",
    mcp: {
      expose: true,
      confirm: { effect: "Create this project. Its slug is permanent and the project cannot be removed." },
    },
    async run(scope, { body }) {
      const project = await create({ user: { id: scope.membership.userId } }, body);
      return { status: 201, body: toProject(project) };
    },
  }),
];
