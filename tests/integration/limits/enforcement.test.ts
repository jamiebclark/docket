import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerPublishLimits } from "../../../src/providers/limits";
import { providers } from "../../../src/providers/registry";
import { mediaConstraintsOf } from "../../../src/providers/media";
import type { ValidationIssue } from "../../../src/providers/types";
import { allowanceUses } from "../../../src/server/db/schema/scheduler";
import { posts as postsTable, postTargets } from "../../../src/server/db/schema/posts";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";
import { validateResolvedContent } from "../../../src/server/services/posts/validate";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { createFakePds, mintJwt, type FakePds } from "../../helpers/fake-pds";
import { createProjectWithMembers, createVideoAsset } from "../../helpers/factories";
import { fakeSession } from "../../helpers/auth";
import { forProject } from "../../../src/server/dal/scope";
import { postsEnv } from "../../helpers/posts-env";
import { createDraftPost, createDueTarget, createMediaAsset, createMockAccount, createSlots, parkAllDueTargets } from "../../helpers/scheduling";
import { allowanceRows, coreRows, limitRows, planWith, plannerRows, textRows, videoRowContent, videoRows, type Expectation } from "../../helpers/limit-rows";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";

/** Any request to a platform fails the test: every row below must be refused or deferred before one is made. */
const platformCalls: string[] = [];
beforeEach(async () => {
  await parkAllDueTargets();
  platformCalls.length = 0;
  vi.stubGlobal("fetch", (input: unknown) => {
    platformCalls.push(String(input instanceof Request ? input.url : input));
    return Promise.reject(new Error("a platform request was made"));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(platformCalls).toEqual([]);
});
afterAll(closeDb);

const BEFORE = new Date("2026-10-01T12:00:00Z");
const T0 = new Date("2026-10-05T09:00:00Z");

/** A failed assertion inside a row generator fails the test that runs it. */
const assert = (cond: boolean, message: string) => expect(cond, message).toBe(true);

function expectOutcome(issues: readonly ValidationIssue[], e: Expectation): void {
  const errors = issues.filter((i) => i.severity === "error").map((i) => i.code);
  if ("refuse" in e) expect(errors.some((c) => e.refuse.includes(c)), `expected one of ${e.refuse.join(", ")}, got ${errors.join(", ")}`).toBe(true);
  else expect(errors.filter((c) => e.accept.includes(c))).toEqual([]);
}

describe("capability rows: the shared validation core (scheduling gate and publish engine) refuses past the limit and accepts what is allowed", () => {
  for (const provider of providers) {
    for (const row of coreRows(provider)) {
      it(row.title, () => expectOutcome(validateResolvedContent(provider, { text: row.text, media: row.media }), row.expect));
    }
  }
});

/** A post whose only target is due at `dueAt`, with `mediaIds` attached. */
async function dueTargetWithMedia(projectId: string, accountId: string, text: string, mediaIds: string[], dueAt: Date) {
  const repos = forSchedulerProject(projectId);
  const { post, targets } = await createDraftPost(projectId, { baseText: text, accountIds: [accountId], mediaIds });
  const target = await repos.targets.update(targets[0]!.id, { status: "scheduled", scheduleKind: "explicit", scheduledAt: dueAt, nextAttemptAt: dueAt });
  await repos.posts.setStatus(post.id, "scheduled");
  return target!;
}

describe("text rows: refused when scheduling and again at publish time, with no platform request (D14 a, b)", () => {
  for (const provider of providers) {
    for (const row of textRows(provider)) {
      it(row.title, async () => {
        const env = await createProjectWithMembers();
        const scope = await forProject(fakeSession(env.owner.id), env.project.slug);
        const account = await createMockAccount(env.project.id, {}, { providerKey: provider.key });
        await createSlots(env.project.id, account.id, [{ weekday: 1, localTime: "09:00" }]);
        // A media-required provider gets a stored image of an accepted type, so only the text breaks the limit.
        const mediaIds = row.media.length > 0 ? [(await createMediaAsset(env.project.id, { mimeType: row.media[0]!.mimeType })).id] : [];

        // Before scheduling.
        const draft = await posts.createDraft(scope, { baseText: row.text, targets: [{ accountId: account.id }], mediaIds });
        const queued = await atTime(BEFORE, () => posts.addToQueue(scope, draft.post.id, {}));
        expect(queued[0]).toMatchObject({ ok: false, code: "validation" });
        expectOutcome(queued[0]!.ok ? [] : (queued[0]!.issues ?? []), row.expect);

        // At publish time: scheduled while valid by the engine's view, content then past the limit.
        const target = await dueTargetWithMedia(env.project.id, account.id, row.text, mediaIds, new Date(T0.getTime() - 1000));
        await atTime(T0, () => runTick());
        const after = await forSchedulerProject(env.project.id).targets.get(target.id);
        expect(after).toMatchObject({ status: "failed", externalId: null });
        expect(after!.lastError).toMatch(new RegExp(`^Can't publish to ${provider.displayName.replace(/[()]/g, "\\$&")}: `));
        const attempts = await forSchedulerProject(env.project.id).attempts.listForTarget(target.id);
        expect(attempts.map((a) => [a.step, a.outcome])).toEqual([["engine-validate", "fatal_error"]]);
      });
    }
  }
});

describe("video rows: refused by the core, when scheduling and at publish time, and the provider's advance is never called (FR-039, SC-002, SC-008)", () => {
  for (const provider of providers) {
    for (const row of videoRows(provider)) {
      it(row.title, async () => {
        const advance = vi.spyOn(provider, "advance");
        expectOutcome(validateResolvedContent(provider, videoRowContent(provider, row)), { refuse: row.codes });

        const env = await createProjectWithMembers();
        const scope = await forProject(fakeSession(env.owner.id), env.project.slug);
        const account = await createMockAccount(env.project.id, {}, { providerKey: provider.key });
        await createSlots(env.project.id, account.id, [{ weekday: 1, localTime: "09:00" }]);
        const mediaIds: string[] = [];
        if (row.withImage) mediaIds.push((await createMediaAsset(env.project.id, { mimeType: provider.capabilities.media.allowedMimeTypes[0] })).id);
        for (const facts of row.videos) mediaIds.push((await createVideoAsset(env.project.id, facts)).id);

        // A draft cannot hold more than 10 items at all (the schema refuses it), so an 11-item row stops at the core.
        if (mediaIds.length > 10) {
          await expect(posts.createDraft(scope, { baseText: "hi", targets: [{ accountId: account.id }], mediaIds })).rejects.toThrow();
          advance.mockRestore();
          return;
        }

        // Before scheduling.
        const draft = await posts.createDraft(scope, {
          baseText: "hi",
          targets: [{ accountId: account.id, ...(row.chosenPostType ? { postType: row.chosenPostType } : {}) }],
          mediaIds,
        });
        const queued = await atTime(BEFORE, () => posts.addToQueue(scope, draft.post.id, {}));
        expect(queued[0]).toMatchObject({ ok: false, code: "validation" });
        expectOutcome(queued[0]!.ok ? [] : (queued[0]!.issues ?? []), { refuse: row.codes });

        // At publish time: a first-step target whose media breaks the limit fails on the engine's own check.
        const target = await dueTargetWithMedia(env.project.id, account.id, "hi", mediaIds, new Date(T0.getTime() - 1000));
        await atTime(T0, () => runTick());
        const after = await forSchedulerProject(env.project.id).targets.get(target.id);
        expect(after).toMatchObject({ status: "failed", externalId: null });
        const attempts = await forSchedulerProject(env.project.id).attempts.listForTarget(target.id);
        expect(attempts.map((a) => [a.step, a.outcome])).toEqual([["engine-validate", "fatal_error"]]);
        expect(advance).not.toHaveBeenCalled();
        advance.mockRestore();
      });
    }
  }
});

describe("media planner rows: each provider's own constraints adapt or refuse an image before validation (D15)", () => {
  for (const provider of providers) {
    for (const row of plannerRows(provider, assert)) {
      it(row.title, () => {
        row.check(planWith(provider, row.asset), mediaConstraintsOf(provider.capabilities));
        if (row.inside) {
          // Just inside the limit, the same rule does not fire.
          const inside = planWith(provider, row.inside);
          if (["formats", "bytes per file", "max width", "max height"].includes(row.category)) expect(inside).toEqual({ kind: "original" });
          else expect(inside.kind).not.toBe("refuse");
        }
      });
    }
  }
});

describe("publish limits defer without a platform request or a counted attempt (D14 c, D15)", () => {
  for (const provider of providers) {
    for (const row of limitRows(provider)) {
      it(row.title, async () => {
        const env = await createProjectWithMembers();
        const account = await createMockAccount(env.project.id, {}, { providerKey: provider.key });
        if (row.accountLevel) {
          // The provider declares none, so only the account's own limit can defer.
          expect(providerPublishLimits(provider)).toEqual([]);
          const scope = await forProject(fakeSession(env.owner.id), env.project.slug);
          await accounts.setPublishLimit(scope, account.id, row.limit);
        }
        const { limit, all } = row;
        // Start times sit inside this window but outside every shorter one, so only this limit is full.
        const shorter = all.filter((l) => l.windowSeconds < limit.windowSeconds).map((l) => l.windowSeconds);
        const ageSeconds = Math.max(0, ...shorter) + 600;
        const startedAt = new Date(T0.getTime() - ageSeconds * 1000);
        const db = testDb();
        for (let from = 0; from < limit.count; from += 1000) {
          const n = Math.min(1000, limit.count - from);
          const ids = await db
            .insert(postsTable)
            .values(Array.from({ length: n }, () => ({ projectId: env.project.id, baseText: "seed" })))
            .returning({ id: postsTable.id });
          await db.insert(postTargets).values(
            ids.map((p) => ({
              projectId: env.project.id,
              postId: p.id,
              socialAccountId: account.id,
              status: "failed" as const,
              publishStartedAt: startedAt,
            })),
          );
        }
        const { target } = await createDueTarget(env.project.id, account.id, { baseText: "hi", dueAt: new Date(T0.getTime() - 1000) });
        await atTime(T0, () => runTick({ config: { maxItems: 100 } }));
        const repos = forSchedulerProject(env.project.id);
        const after = await repos.targets.get(target.id);
        expect(after).toMatchObject({ status: "scheduled", attemptCount: 0 });
        expect(after!.nextAttemptAt!.getTime()).toBe(startedAt.getTime() + limit.windowSeconds * 1000);
        expect((await repos.attempts.listForTarget(target.id)).map((a) => a.outcome)).toEqual(["deferred"]);
      }, 60_000);
    }
  }
});

describe("a creation allowance defers without a platform request or a counted attempt (FR-019)", () => {
  for (const provider of providers) {
    for (const row of allowanceRows(provider)) {
      it(row.title, async () => {
        const env = await createProjectWithMembers();
        const account = await createMockAccount(env.project.id, {}, { providerKey: provider.key });
        const usedAt = new Date(T0.getTime() - 600 * 1000);
        await testDb().insert(allowanceUses).values({ projectId: env.project.id, socialAccountId: account.id, units: row.count, createdAt: usedAt });
        const { target, post } = await createDueTarget(env.project.id, account.id, { baseText: "hi", dueAt: new Date(T0.getTime() - 1000) });
        const asset = await createMediaAsset(env.project.id);
        await forSchedulerProject(env.project.id).posts.setMedia(post.id, [asset.id]);
        await atTime(T0, () => runTick({ config: { maxItems: 100 } }));
        const repos = forSchedulerProject(env.project.id);
        const after = await repos.targets.get(target.id);
        expect(after).toMatchObject({ status: "scheduled", attemptCount: 0 });
        expect(after!.nextAttemptAt!.getTime()).toBe(usedAt.getTime() + row.windowSeconds * 1000 + 1000);
        expect(after!.lastError).toContain(row.name);
        expect((await repos.attempts.listForTarget(target.id)).map((a) => a.outcome)).toEqual(["deferred"]);
      });
    }
  }
});

describe("Bluesky publishing does not create a session (FR-019)", () => {
  let pds: FakePds;
  const ACCESS = mintJwt(new Date("2030-01-01T01:00:00Z"));
  const REFRESH = mintJwt(new Date("2030-03-01T00:00:00Z"));
  const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
  const CID = "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgzmq2vz2m";

  it("connects once, then publishes three posts with createSession hit exactly once", async () => {
    pds = createFakePds();
    vi.stubGlobal("fetch", pds.fetch);
    pds.route("POST", "/xrpc/com.atproto.server.createSession", { json: { accessJwt: ACCESS, refreshJwt: REFRESH, did: DID, handle: "me.bsky.social" } });
    pds.route("POST", "/xrpc/com.atproto.repo.createRecord", { json: { uri: `at://${DID}/app.bsky.feed.post/3kabc`, cid: CID } });
    const env = await postsEnv();
    const out = await accounts.connectWithCredentials(env.scope, {
      providerKey: "bluesky",
      fields: { handle: "me.bsky.social", appPassword: "abcd-efgh-ijkl-mnop", pdsUrl: "" },
    });
    if (!out.ok) throw new Error("connect failed");
    for (let i = 0; i < 3; i++) await createDueTarget(env.project.id, out.account.id, { baseText: `post ${i}` });
    const counts = (await runTick({ config: { maxItems: 100 } })).publishing.counts;
    expect(counts.done).toBe(3);
    expect(pds.callsTo("POST", "/xrpc/com.atproto.server.createSession")).toHaveLength(1);
    expect(pds.callsTo("POST", "/xrpc/com.atproto.server.refreshSession")).toHaveLength(0);
    expect(pds.callsTo("POST", "/xrpc/com.atproto.repo.createRecord")).toHaveLength(3);
  });
});
