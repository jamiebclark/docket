import { projects } from "../db/schema";

/** The one definition of which `projects` columns a scope or an authenticated key carries. */
export const projectColumns = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  timezone: projects.timezone,
  defaultApprovalPolicy: projects.defaultApprovalPolicy,
  defaultSchedulingPolicy: projects.defaultSchedulingPolicy,
  defaultVoiceProfileId: projects.defaultVoiceProfileId,
  tagline: projects.tagline,
  description: projects.description,
  websiteUrl: projects.websiteUrl,
};
