import { afterAll, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import pg from "pg";
import { ForbiddenError, NotFoundError } from "../../src/server/dal/errors";
import { forProject } from "../../src/server/dal/scope";
import { runCrossProject } from "../../src/server/db/cross-project";
import { invitation } from "../../src/server/db/schema";
import * as invitations from "../../src/server/services/invitations";
import * as members from "../../src/server/services/members";
import { fakeSession } from "../helpers/auth";
import { closeDb, testDb } from "../helpers/db";
import { createProjectWithMembers } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const inviteCount = (projectId: string) =>
  runCrossProject("test", async () => {
    const [row] = await testDb().select({ n: count() }).from(invitation).where(eq(invitation.organizationId, projectId));
    return row!.n;
  });

/** Holds a raw transaction that has locked the project row; `release` commits it. */
async function holdLock(projectId: string, mutate: (c: pg.Client) => Promise<void>) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("begin");
  await client.query("select id from projects where id = $1 for update", [projectId]);
  await mutate(client);
  return {
    release: async () => {
      await client.query("commit");
      await client.end();
    },
  };
}

/** Starts `run`, gives it time to block on the lock, then commits the raw transaction. */
async function raceUnderLock<T>(lock: Awaited<ReturnType<typeof holdLock>>, run: () => Promise<T>) {
  const pending = run().then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  await new Promise((r) => setTimeout(r, 400));
  await lock.release();
  return pending;
}

describe("locked re-check sees changes committed while waiting for the lock", () => {
  it("rejects with NotFoundError when the caller's membership was deleted", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.admin.id), ctx.project.slug);
    const lock = await holdLock(ctx.project.id, async (c) => {
      await c.query(`delete from member where organization_id = $1 and user_id = $2`, [ctx.project.id, ctx.admin.id]);
    });
    const r = await raceUnderLock(lock, () =>
      invitations.create(scope, { email: `new-${Date.now()}@example.com`, role: "editor" }),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.e).toBeInstanceOf(NotFoundError);
    expect(await inviteCount(ctx.project.id)).toBe(0);
  });

  it("rejects with ForbiddenError when the caller was demoted to editor", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.admin.id), ctx.project.slug);
    const lock = await holdLock(ctx.project.id, async (c) => {
      await c.query(`update member set role = 'editor' where organization_id = $1 and user_id = $2`, [
        ctx.project.id,
        ctx.admin.id,
      ]);
    });
    const r = await raceUnderLock(lock, () => members.remove(scope, { userId: ctx.editor.id }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.e).toBeInstanceOf(ForbiddenError);
  });
});
