import { randomUUID } from "node:crypto";
import { getDb } from "../../src/server/db/client";
import { runCrossProject } from "../../src/server/db/cross-project";
import { member, organization, projects, user } from "../../src/server/db/schema";
import type { Role } from "../../src/server/auth/access";

// Factories write straight through the test client, so they run as deliberate cross-project work.
const unique = () => randomUUID().replace(/-/g, "").slice(0, 12);

export async function createUser(overrides: Partial<typeof user.$inferInsert> = {}) {
  const n = unique();
  return runCrossProject("test factory", async () => {
    const [row] = await getDb()
      .insert(user)
      .values({ name: `User ${n}`, email: `user-${n}@example.test`, ...overrides })
      .returning();
    return row!;
  });
}

export async function createProject(overrides: { name?: string; slug?: string; timezone?: string } = {}) {
  const n = unique();
  const slug = overrides.slug ?? `proj-${n}`;
  const name = overrides.name ?? `Project ${n}`;
  return runCrossProject("test factory", async () => {
    const db = getDb();
    const [org] = await db.insert(organization).values({ name, slug }).returning();
    const [project] = await db
      .insert(projects)
      .values({ id: org!.id, name, slug, timezone: overrides.timezone ?? "UTC" })
      .returning();
    return project!;
  });
}

export async function addMember(projectId: string, userId: string, role: Role = "editor") {
  return runCrossProject("test factory", async () => {
    const [row] = await getDb()
      .insert(member)
      .values({ organizationId: projectId, userId, role })
      .returning();
    return row!;
  });
}

/** A project with one user per role. */
export async function createProjectWithMembers() {
  const project = await createProject();
  const [owner, admin, editor] = await Promise.all([createUser(), createUser(), createUser()]);
  await addMember(project.id, owner.id, "owner");
  await addMember(project.id, admin.id, "admin");
  await addMember(project.id, editor.id, "editor");
  return { project, owner, admin, editor };
}
