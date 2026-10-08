import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { queryObservers, type ObservedQuery } from "../../src/server/db/client";
import { runCrossProject, runForProjectSet } from "../../src/server/db/cross-project";
import { projectOwnedTables } from "../../src/server/db/project-owned";
import { connectAttempts, member, projects } from "../../src/server/db/schema";
import { claimDueTargets, claimRefreshAccounts, forSchedulerProject } from "../../src/server/dal/scheduler";
import { createConnectAttemptsRepo } from "../../src/server/dal/connect-attempts";
import { forMyProjects } from "../../src/server/dal/my-projects";
import { createActivityRepo } from "../../src/server/dal/activity";
import { closeDb, testDb } from "../helpers/db";
import { addMember, createProject, createProjectWithMembers, createUser } from "../helpers/factories";
import { checkScope, type QueryRecord } from "../helpers/scope-check";
import { clearRecordedQueries } from "../setup/scope-recorder";

afterAll(async () => {
  await closeDb();
});

const scopeRepo = (projectId: string) => createConnectAttemptsRepo(testDb(), projectId);

async function capture(fn: () => Promise<unknown>): Promise<QueryRecord[]> {
  const seen: QueryRecord[] = [];
  const obs = (q: ObservedQuery) =>
    seen.push({ sql: q.sql, params: q.params, ...(q.crossProjectReason ? { crossProjectReason: q.crossProjectReason } : {}),
      ...(q.projectSet ? { projectSet: q.projectSet } : {}),
    });
  queryObservers.add(obs);
  try {
    await fn();
  } finally {
    queryObservers.delete(obs);
  }
  return seen;
}

describe("scope check against the real client", () => {
  it("reports an unscoped select on member outside crossProject", async () => {
    const records = await capture(() => testDb().select().from(member));
    const { violations } = checkScope(records, projectOwnedTables);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^Unscoped query on project-owned table "member"/);
    clearRecordedQueries(); // the afterEach hook would otherwise fail this test
  });

  it("passes a pinned query", async () => {
    const { project } = await createProjectWithMembers();
    const records = await capture(() => testDb().select().from(member).where(eq(member.organizationId, project.id)));
    const result = checkScope(records, projectOwnedTables);
    expect(result.violations).toEqual([]);
    expect(result.checked).toBeGreaterThan(0);
  });

  it("skips and counts a crossProject query", async () => {
    const records = await capture(() => runCrossProject("test: list all", async () => await testDb().select().from(member)));
    const result = checkScope(records, projectOwnedTables);
    expect(result.violations).toEqual([]);
    expect(result.crossProject.map((c) => c.reason)).toEqual(["test: list all"]);
  });

  it("covers a new table with one registry line", () => {
    const sql = 'select * from "widgets" where "widgets"."name" = $1';
    expect(checkScope([{ sql }], projectOwnedTables).violations).toEqual([]);
    const registry = [...projectOwnedTables, { table: "widgets", scopeColumn: "project_id" }];
    expect(checkScope([{ sql }], registry).violations).toHaveLength(1);
    expect(
      checkScope([{ sql: 'select * from "widgets" where "widgets"."project_id" = $1' }], registry).violations,
    ).toEqual([]);
  });

  it("keeps the projects registry entry pinned by id", async () => {
    const { project } = await createProjectWithMembers();
    const records = await capture(() => testDb().select().from(projects).where(eq(projects.id, project.id)));
    expect(checkScope(records, projectOwnedTables).violations).toEqual([]);
  });

  it("passes every scheduling repository and both claim queries, with no cross-project reason in the record step", async () => {
    const { project } = await createProjectWithMembers();
    const repos = forSchedulerProject(project.id);
    const now = new Date();
    const records = await capture(async () => {
      const account = await repos.accounts.upsertConnected({
        providerKey: "mock",
        displayName: "Scope check",
        externalAccountId: `ext-${project.id}`,
        settings: {},
        credentialsEncrypted: "ciphertext",
        credentialsExpiresAt: new Date(now.getTime() + 3600_000),
        connectedByUserId: null,
      });
      await repos.accounts.list();
      await repos.accounts.get(account.id);
      await repos.accounts.getForUpdate(account.id);
      await repos.accounts.updateSettings(account.id, { behaviour: "succeed" });
      await repos.accounts.setLimit(account.id, { count: 2, windowSeconds: 60 });
      await repos.accounts.getCredentialsCiphertext(account.id);

      const slot = await repos.slots.insert(account.id, 1, "09:00");
      await repos.slots.get(slot.id);
      await repos.slots.listForAccount(account.id);
      await repos.slots.listActiveForAccount(account.id);
      await repos.slots.setPaused(slot.id, true);
      await repos.slots.delete(slot.id);

      const media = await repos.media.insert({
        storageKey: "k",
        publicUrl: "http://localhost/k.png",
        mimeType: "image/png",
        byteSize: 10,
      });
      await repos.media.get(media.id);
      await repos.media.getMany([media.id]);
      await repos.media.updateAlt(media.id, "alt");
      await repos.media.markUsed([media.id], now);

      const post = await repos.posts.insert({ baseText: "hello" });
      await repos.posts.get(post.id);
      await repos.transaction(async (tx) => {
        await tx.posts.lockForUpdate(post.id);
        await tx.posts.setMedia(post.id, [media.id]);
      });
      await repos.posts.listMediaIds(post.id);
      await repos.posts.update(post.id, { baseText: "hello again" });
      await repos.posts.setStatus(post.id, "scheduled");

      const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
      const t = target!;
      await repos.targets.listForPost(post.id);
      await repos.targets.get(t.id);
      await repos.targets.update(t.id, {
        status: "scheduled",
        scheduleKind: "explicit",
        scheduledAt: now,
        nextAttemptAt: now,
      });
      await repos.targets.heldInstants(account.id, now, now);
      await repos.targets.queuedForAccount(account.id, now);
      await repos.targets.nearScheduled(account.id, now, 1000);
      await repos.targets.effectiveContent(t.id);
      await repos.attempts.insert({ postTargetId: t.id, step: "publish", outcome: "done", at: now });
      await repos.attempts.listForTarget(t.id);
      await repos.attempts.listForTargets([t.id]);
      await repos.targets.listAttention({ statuses: ["ambiguous", "failed"], limit: 5, offset: 0 });
      await repos.targets.countAttention();

      await claimDueTargets({
        now: new Date(now.getTime() + 1000),
        limit: 5,
        excludeIds: [],
        decide: async (row, _account, ctx) => {
          await ctx.startedSince(row.socialAccountId, new Date(0));
          await ctx.contentShape(row);
          return null;
        },
      });
      await claimRefreshAccounts({
        now,
        refreshWindowMs: 7200_000,
        limit: 5,
        leaseMs: 60_000,
        providerKeys: ["mock"],
        token: crypto.randomUUID(),
      });
      await repos.accounts.acquireRefreshLease(account.id, crypto.randomUUID(), {
        now,
        leaseMs: 60_000,
        expectedCiphertext: "not-the-stored-value",
      });
      await repos.accounts.markRemoved(account.id, now);
      await repos.posts.softDelete(post.id, now);
    });

    const result = checkScope(records, projectOwnedTables);
    expect(result.violations).toEqual([]);
    expect(result.checked).toBeGreaterThan(20);
    const reasons = new Set(result.crossProject.map((c) => c.reason));
    expect(reasons).toEqual(
      new Set(["scheduler: claim due targets", "scheduler: claim token refresh"]),
    );
    // Everything but the two claim transactions ran pinned.
    expect(records.filter((r) => !r.crossProjectReason && /^(select|insert|update|delete)/i.test(r.sql)).length).toBeGreaterThan(20);
  });

  it("covers connect_attempts: a pinned repo passes, an unscoped query fails", async () => {
    expect(projectOwnedTables.some((t) => t.table === "connect_attempts")).toBe(true);
    const { project } = await createProjectWithMembers();
    const repo = scopeRepo(project.id);
    const records = await capture(async () => {
      await repo.getReady(crypto.randomUUID(), { userId: crypto.randomUUID(), sessionId: crypto.randomUUID(), now: new Date() });
    });
    expect(checkScope(records, projectOwnedTables).violations).toEqual([]);
    const bad = await capture(() => testDb().select().from(connectAttempts));
    expect(checkScope(bad, projectOwnedTables).violations).toHaveLength(1);
    clearRecordedQueries();
  });

  it("passes a real forMyProjects list and summary, and fails a pin outside the caller's set", async () => {
    const mine = await createProject();
    const other = await createProject();
    const me = await createUser();
    await addMember(mine.id, me.id, "owner");
    const set = await forMyProjects({ user: { id: me.id } });
    const q = { windows: [{ projectId: mine.id, from: null, to: null }], outcomes: null, platform: null, accountId: null };
    const records = await capture(async () => {
      await set.activity.list({ ...q, cursor: null, direction: "older", limit: 5 });
      await set.activity.summary(q);
    });
    expect(records.every((r) => r.projectSet?.projectIds.includes(mine.id))).toBe(true);
    const result = checkScope(records, projectOwnedTables);
    expect(result.violations).toEqual([]);
    expect(result.projectSet.length).toBeGreaterThanOrEqual(2);

    // A reader built over a wider set than the caller's, asked about a project outside it, is caught by the harness.
    const wide = createActivityRepo(testDb(), other.id);
    const stray = await capture(() =>
      runForProjectSet({ reason: "activity: my projects", projectIds: [mine.id] }, () =>
        wide.list({ ...q, windows: [{ projectId: other.id, from: null, to: null }], cursor: null, direction: "older", limit: 5 }),
      ),
    );
    expect(checkScope(stray, projectOwnedTables).violations.join("\n")).toMatch(/outside the caller's set/);
    clearRecordedQueries(); // the afterEach hook would otherwise fail this test
  });
});
