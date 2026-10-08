import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { member, notificationStates, organization, projects } from "../db/schema";
import { ConflictError } from "./errors";
import { crossProject } from "./scope";

export interface NewProject {
  name: string;
  slug: string;
  timezone: string;
}

export interface ProjectSummary {
  slug: string;
  name: string;
}

export interface ProjectRecord extends ProjectSummary {
  id: string;
  timezone: string;
  defaultApprovalPolicy: (typeof projects.$inferSelect)["defaultApprovalPolicy"];
  defaultSchedulingPolicy: (typeof projects.$inferSelect)["defaultSchedulingPolicy"];
  defaultVoiceProfileId: string | null;
}

/**
 * Creates `organization`, `projects` (same id) and the creator's `member(owner)` in one
 * transaction. A slug collision surfaces as a `ConflictError` on `slug` and writes nothing.
 */
export async function createProject(
  userId: string,
  input: NewProject,
  db: Database = getDb(),
): Promise<ProjectRecord> {
  return crossProject("create project", async () => {
    try {
      return await db.transaction(async (tx) => {
        const [org] = await tx
          .insert(organization)
          .values({ name: input.name, slug: input.slug })
          .returning({ id: organization.id });
        if (!org) throw new Error("Organization insert returned no row");
        const [project] = await tx
          .insert(projects)
          .values({ id: org.id, name: input.name, slug: input.slug, timezone: input.timezone })
          .returning();
        if (!project) throw new Error("Project insert returned no row");
        await tx.insert(member).values({ organizationId: org.id, userId, role: "owner" });
        await tx.insert(notificationStates).values({ projectId: org.id, userId, seenSeq: 0n });
        return project;
      });
    } catch (error) {
      // 23505 = unique_violation on the slug.
      const code = (error as { code?: string; cause?: { code?: string } });
      if ((code.code ?? code.cause?.code) === "23505") {
        throw new ConflictError("That URL name is already taken.", "slug");
      }
      throw error;
    }
  });
}

/** The projects `userId` belongs to, ordered by name (for the switcher). */
export async function listMyProjects(
  userId: string,
  db: Database = getDb(),
): Promise<Array<ProjectSummary & { joinedAt: Date }>> {
  // `await` inside the callback: drizzle queries are lazy and must run within the cross-project context.
  return crossProject("list my projects", async () =>
    await db
      .select({ slug: projects.slug, name: projects.name, joinedAt: member.createdAt })
      .from(member)
      .innerJoin(projects, eq(projects.id, member.organizationId))
      .where(eq(member.userId, userId))
      .orderBy(projects.name),
  );
}

/** One project by id, for a caller that already holds its scope. */
export async function getProject(projectId: string, db: Database = getDb()): Promise<ProjectRecord | null> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId)))
    .limit(1);
  return row ?? null;
}

export interface ProjectSettingsPatch {
  name: string;
  slug: string;
  timezone: string;
  defaultApprovalPolicy: ProjectRecord["defaultApprovalPolicy"];
  defaultSchedulingPolicy: ProjectRecord["defaultSchedulingPolicy"];
}

/**
 * Updates the project row and mirrors name/slug onto `organization` (same id). Call inside a
 * transaction so both rows move together; a taken slug surfaces as a `ConflictError` on `slug`.
 */
export async function updateProject(
  projectId: string,
  patch: ProjectSettingsPatch,
  db: Database = getDb(),
): Promise<ProjectRecord> {
  try {
    const [project] = await db
      .update(projects)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();
    if (!project) throw new Error("Project update returned no row");
    await db
      .update(organization)
      .set({ name: patch.name, slug: patch.slug })
      .where(eq(organization.id, projectId));
    return project;
  } catch (error) {
    const code = error as { code?: string; cause?: { code?: string } };
    if ((code.code ?? code.cause?.code) === "23505") {
      throw new ConflictError("That URL name is already taken.", "slug");
    }
    throw error;
  }
}

/** Sets (or with `null` clears) the project's default voice profile. The service validates the profile first. */
export async function setDefaultVoiceProfile(
  projectId: string,
  profileId: string | null,
  db: Database = getDb(),
): Promise<void> {
  await db.update(projects).set({ defaultVoiceProfileId: profileId }).where(eq(projects.id, projectId));
}
