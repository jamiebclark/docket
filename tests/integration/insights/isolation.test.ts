import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { forProject } from "../../../src/server/dal/scope";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runCrossProject } from "../../../src/server/db/cross-project";
import {
  accountMetricPollStates,
  accountMetricSnapshots,
  postMetricPollStates,
  postMetricSnapshots,
  postTargets,
  posts,
  projects,
  socialAccounts,
} from "../../../src/server/db/schema";
import * as accounts from "../../../src/server/services/accounts";
import { fakeSession } from "../../helpers/auth";
import { closeDb, testDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

afterAll(closeDb);
beforeEach(parkAllDueTargets);

const NOW = new Date("2026-04-01T00:00:00Z");

async function publishedTarget(projectId: string, accountId: string) {
  const repos = forSchedulerProject(projectId);
  const post = await repos.posts.insert({ baseText: "Hello" });
  const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: accountId }]);
  await repos.targets.update(target!.id, { status: "published", externalId: "ext-1", publishedAt: NOW });
  return { post, target: target! };
}

async function withSnapshotsAndStates(projectId: string, accountId: string) {
  const { post, target } = await publishedTarget(projectId, accountId);
  const repos = forSchedulerProject(projectId);
  await repos.postMetricSnapshots.insertIfAbsent({
    postTargetId: target.id,
    socialAccountId: accountId,
    providerKey: "mock",
    capturedAt: NOW,
    metrics: { likeCount: 1 },
  });
  await repos.accountMetricSnapshots.insertIfAbsent({
    socialAccountId: accountId,
    providerKey: "mock",
    capturedAt: NOW,
    metrics: { followersCount: 1 },
  });
  await testDb()
    .insert(postMetricPollStates)
    .values({ postTargetId: target.id, projectId, socialAccountId: accountId, nextPollAt: NOW })
    .onConflictDoNothing({ target: postMetricPollStates.postTargetId });
  await testDb()
    .insert(accountMetricPollStates)
    .values({ socialAccountId: accountId, projectId, nextPollAt: NOW })
    .onConflictDoNothing({ target: accountMetricPollStates.socialAccountId });
  return { post, target };
}

describe("insights cross-project isolation (FR-022, research.md §13)", () => {
  it("another project's snapshots and poll states are unreachable through any repo", async () => {
    const mine = await createProjectWithMembers();
    const theirs = await createProjectWithMembers();
    const theirAccount = await createMockAccount(theirs.project.id);
    const { target } = await withSnapshotsAndStates(theirs.project.id, theirAccount.id);

    const myScope = await forProject(fakeSession(mine.owner.id), mine.project.slug);

    expect(await myScope.postMetricSnapshots.latestForTargets([target.id])).toEqual(new Map());
    expect(await myScope.accountMetricSnapshots.latestForAccounts([theirAccount.id])).toEqual(new Map());
    expect(await myScope.postMetricPollStates.get(target.id)).toBeNull();
    expect(await myScope.accountMetricPollStates.get(theirAccount.id)).toBeNull();
    expect(await myScope.postMetricSnapshots.countForAccountSince(theirAccount.id, new Date(0))).toBe(0);
    expect(await myScope.accountMetricSnapshots.countForAccountSince(theirAccount.id, new Date(0))).toBe(0);
  });

  it("deleting a project's row deletes its snapshot and poll-state rows across all four tables", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const { target } = await withSnapshotsAndStates(ctx.project.id, account.id);

    await runCrossProject("test: delete a project", () => testDb().delete(projects).where(eq(projects.id, ctx.project.id)));

    expect(
      await runCrossProject("test: assert deletion", async () =>
        testDb().select().from(postMetricSnapshots).where(eq(postMetricSnapshots.postTargetId, target.id)),
      ),
    ).toHaveLength(0);
    expect(
      await runCrossProject("test: assert deletion", async () =>
        testDb().select().from(accountMetricSnapshots).where(eq(accountMetricSnapshots.socialAccountId, account.id)),
      ),
    ).toHaveLength(0);
    expect(
      await runCrossProject("test: assert deletion", async () =>
        testDb().select().from(postMetricPollStates).where(eq(postMetricPollStates.postTargetId, target.id)),
      ),
    ).toHaveLength(0);
    expect(
      await runCrossProject("test: assert deletion", async () =>
        testDb().select().from(accountMetricPollStates).where(eq(accountMetricPollStates.socialAccountId, account.id)),
      ),
    ).toHaveLength(0);
  });

  it("deleting a post cascades to its target's snapshot and poll-state rows", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const { post, target } = await withSnapshotsAndStates(ctx.project.id, account.id);

    await runCrossProject("test: delete a post", () =>
      testDb().delete(posts).where(and(eq(posts.projectId, ctx.project.id), eq(posts.id, post.id))),
    );

    expect(
      await testDb()
        .select()
        .from(postMetricSnapshots)
        .where(and(eq(postMetricSnapshots.projectId, ctx.project.id), eq(postMetricSnapshots.postTargetId, target.id))),
    ).toHaveLength(0);
    expect(
      await testDb()
        .select()
        .from(postMetricPollStates)
        .where(and(eq(postMetricPollStates.projectId, ctx.project.id), eq(postMetricPollStates.postTargetId, target.id))),
    ).toHaveLength(0);
  });

  it("deleting a target cascades to its own snapshot and poll-state rows only", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const { target } = await withSnapshotsAndStates(ctx.project.id, account.id);
    const { target: other } = await withSnapshotsAndStates(ctx.project.id, account.id);

    await runCrossProject("test: delete a target", () =>
      testDb().delete(postTargets).where(and(eq(postTargets.projectId, ctx.project.id), eq(postTargets.id, target.id))),
    );

    expect(
      await testDb()
        .select()
        .from(postMetricSnapshots)
        .where(and(eq(postMetricSnapshots.projectId, ctx.project.id), eq(postMetricSnapshots.postTargetId, target.id))),
    ).toHaveLength(0);
    expect(
      await testDb()
        .select()
        .from(postMetricPollStates)
        .where(and(eq(postMetricPollStates.projectId, ctx.project.id), eq(postMetricPollStates.postTargetId, target.id))),
    ).toHaveLength(0);
    expect(
      await testDb()
        .select()
        .from(postMetricSnapshots)
        .where(and(eq(postMetricSnapshots.projectId, ctx.project.id), eq(postMetricSnapshots.postTargetId, other.id))),
    ).toHaveLength(1);
    expect(
      await testDb()
        .select()
        .from(postMetricPollStates)
        .where(and(eq(postMetricPollStates.projectId, ctx.project.id), eq(postMetricPollStates.postTargetId, other.id))),
    ).toHaveLength(1);
  });

  it("hard-deleting an account's row cascades to its own account-metric rows", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const repos = forSchedulerProject(ctx.project.id);
    await repos.accountMetricSnapshots.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      capturedAt: NOW,
      metrics: { followersCount: 1 },
    });
    await testDb()
      .insert(accountMetricPollStates)
      .values({ socialAccountId: account.id, projectId: ctx.project.id, nextPollAt: NOW })
      .onConflictDoNothing({ target: accountMetricPollStates.socialAccountId });

    await runCrossProject("test: delete an account", () =>
      testDb().delete(socialAccounts).where(and(eq(socialAccounts.projectId, ctx.project.id), eq(socialAccounts.id, account.id))),
    );

    expect(
      await runCrossProject("test: assert deletion", async () =>
        testDb().select().from(accountMetricSnapshots).where(eq(accountMetricSnapshots.socialAccountId, account.id)),
      ),
    ).toHaveLength(0);
    expect(
      await runCrossProject("test: assert deletion", async () =>
        testDb().select().from(accountMetricPollStates).where(eq(accountMetricPollStates.socialAccountId, account.id)),
      ),
    ).toHaveLength(0);
  });

  it("soft-deleting an account leaves its snapshots readable and removes its poll states", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    const { target } = await withSnapshotsAndStates(ctx.project.id, account.id);
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);

    await accounts.removeAccount(scope, account.id);

    expect(await scope.postMetricSnapshots.latestForTargets([target.id])).not.toEqual(new Map());
    expect(await scope.accountMetricSnapshots.latestForAccounts([account.id])).not.toEqual(new Map());
    expect(await scope.postMetricPollStates.get(target.id)).toBeNull();
    expect(await scope.accountMetricPollStates.get(account.id)).toBeNull();
  });
});
