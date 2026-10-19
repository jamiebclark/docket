import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { postTargets } from "../../../src/server/db/schema/posts";
import { accountMetricPollStates, postMetricPollStates } from "../../../src/server/db/schema/insights";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { closeDb, testDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { createMockAccount } from "../../helpers/scheduling";
import { clearRecordedQueries } from "../../setup/scope-recorder";

afterAll(async () => {
  await closeDb();
});

async function publishedTarget() {
  const ctx = await createProjectWithMembers();
  const account = await createMockAccount(ctx.project.id);
  const repos = forSchedulerProject(ctx.project.id);
  const post = await repos.posts.insert({ baseText: "Hello" });
  const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
  await repos.targets.update(target!.id, { status: "published", externalId: "ext-1", publishedAt: new Date() });
  return { projectId: ctx.project.id, accountId: account.id, targetId: target!.id };
}

function unwrap(err: unknown): unknown {
  return err instanceof Error && err.cause instanceof Error ? err.cause : err;
}

async function expectCheckViolation(p: Promise<unknown>): Promise<void> {
  try {
    await p;
    throw new Error("expected a CHECK violation, got success");
  } catch (err) {
    const cause = unwrap(err);
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toMatch(/violates check constraint/);
  }
}

describe("post_targets_public_post_id_len CHECK (data-model.md §1)", () => {
  it("rejects a 0-character value", async () => {
    const { targetId } = await publishedTarget();
    await expectCheckViolation(
      testDb().update(postTargets).set({ publicPostId: "" }).where(eq(postTargets.id, targetId)),
    );
    clearRecordedQueries();
  });

  it("rejects a 65-character value", async () => {
    const { targetId } = await publishedTarget();
    await expectCheckViolation(
      testDb()
        .update(postTargets)
        .set({ publicPostId: "x".repeat(65) })
        .where(eq(postTargets.id, targetId)),
    );
    clearRecordedQueries();
  });

  it("accepts a 1-character and a 64-character value", async () => {
    const { targetId } = await publishedTarget();
    await testDb().update(postTargets).set({ publicPostId: "x" }).where(eq(postTargets.id, targetId));
    await testDb()
      .update(postTargets)
      .set({ publicPostId: "x".repeat(64) })
      .where(eq(postTargets.id, targetId));
    clearRecordedQueries();
  });
});

describe("unavailable_reason / unavailable_docs_path CHECKs on post_metric_poll_states (data-model.md §2)", () => {
  it("rejects a 501-character unavailable_reason", async () => {
    const { projectId, accountId, targetId } = await publishedTarget();
    await expectCheckViolation(
      testDb().insert(postMetricPollStates).values({
        postTargetId: targetId,
        projectId,
        socialAccountId: accountId,
        unavailableReason: "x".repeat(501),
      }),
    );
    clearRecordedQueries();
  });

  it("rejects a 101-character unavailable_docs_path", async () => {
    const { projectId, accountId, targetId } = await publishedTarget();
    await expectCheckViolation(
      testDb().insert(postMetricPollStates).values({
        postTargetId: targetId,
        projectId,
        socialAccountId: accountId,
        unavailableReason: "reason",
        unavailableDocsPath: "x".repeat(101),
      }),
    );
    clearRecordedQueries();
  });

  it("rejects a non-null unavailable_docs_path paired with a null unavailable_reason", async () => {
    const { projectId, accountId, targetId } = await publishedTarget();
    await expectCheckViolation(
      testDb().insert(postMetricPollStates).values({
        postTargetId: targetId,
        projectId,
        socialAccountId: accountId,
        unavailableDocsPath: "docs/path",
      }),
    );
    clearRecordedQueries();
  });

  it("accepts a reason with no docs path, and a reason with one", async () => {
    const a = await publishedTarget();
    await testDb().insert(postMetricPollStates).values({
      postTargetId: a.targetId,
      projectId: a.projectId,
      socialAccountId: a.accountId,
      unavailableReason: "reason only",
    });
    const b = await publishedTarget();
    await testDb().insert(postMetricPollStates).values({
      postTargetId: b.targetId,
      projectId: b.projectId,
      socialAccountId: b.accountId,
      unavailableReason: "reason",
      unavailableDocsPath: "docs/path",
    });
    clearRecordedQueries();
  });
});

describe("unavailable_reason / unavailable_docs_path CHECKs on account_metric_poll_states (data-model.md §2)", () => {
  it("rejects a 501-character unavailable_reason", async () => {
    const { projectId, accountId } = await publishedTarget();
    await expectCheckViolation(
      testDb().insert(accountMetricPollStates).values({
        socialAccountId: accountId,
        projectId,
        unavailableReason: "x".repeat(501),
      }),
    );
    clearRecordedQueries();
  });

  it("rejects a 101-character unavailable_docs_path", async () => {
    const { projectId, accountId } = await publishedTarget();
    await expectCheckViolation(
      testDb().insert(accountMetricPollStates).values({
        socialAccountId: accountId,
        projectId,
        unavailableReason: "reason",
        unavailableDocsPath: "x".repeat(101),
      }),
    );
    clearRecordedQueries();
  });

  it("rejects a non-null unavailable_docs_path paired with a null unavailable_reason", async () => {
    const { projectId, accountId } = await publishedTarget();
    await expectCheckViolation(
      testDb().insert(accountMetricPollStates).values({
        socialAccountId: accountId,
        projectId,
        unavailableDocsPath: "docs/path",
      }),
    );
    clearRecordedQueries();
  });
});
