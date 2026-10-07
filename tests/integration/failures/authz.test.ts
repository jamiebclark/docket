import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import FailuresPage from "../../../src/app/p/[projectSlug]/failures/page";
import * as failureActions from "../../../src/app/p/[projectSlug]/failures/actions";
import * as postActions from "../../../src/app/p/[projectSlug]/posts/actions";
import { forApiKey } from "../../../src/server/dal/scope";
import { ForbiddenError } from "../../../src/server/dal/errors";
import { listFailures, previewRequeue } from "../../../src/server/services/failures";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { actAs, NotFoundSignal } from "../../helpers/actions";
import { createKey } from "../../helpers/api";
import { closeDb } from "../../helpers/db";
import { createUser } from "../../helpers/factories";
import { LATER, outcomeTarget } from "../../helpers/failures";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  actAs(null);
  await closeDb();
});

const render = (slug: string) => FailuresPage({ params: Promise.resolve({ projectSlug: slug }), searchParams: Promise.resolve({}) });

describe("failures access", () => {
  it("non-members and members of another project get not-found for the page and every action", async () => {
    const env = await postsEnv();
    const other = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    const outsider = await createUser();
    for (const user of [outsider, other.owner]) {
      actAs(user);
      await expect(render(env.project.slug)).rejects.toBeInstanceOf(NotFoundSignal);
      const results = [
        await postActions.retryTargetAction(env.project.slug, { targetId: t.targetId }),
        await postActions.retryTargetAction(env.project.slug, { targetId: t.targetId, mode: "requeue" } as never),
        await postActions.retryTargetAction(env.project.slug, { targetId: t.targetId, mode: "at", at: "2026-10-07T15:00:00.000Z" } as never),
        await postActions.resolveTargetAction(env.project.slug, { targetId: t.targetId, outcome: "published" }),
        await postActions.resolveTargetAction(env.project.slug, { targetId: t.targetId, outcome: "not_published", requeue: false }),
        await postActions.previewRequeueAction(env.project.slug, { targetId: t.targetId }),
      ];
      for (const r of results) expect(r).toMatchObject({ ok: false, error: "not_found" });
    }
    actAs(null);
    expect((await posts.getPost(env.scope, t.postId)).targets[0]!.status).toBe("ambiguous");
  });

  it("an API key without write rights can read but not resolve, retry or preview", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    const key = await createKey(env.scope, ["read"]);
    const { scope } = await forApiKey(key.secret);
    await expect(listFailures(scope)).resolves.toBeTruthy();
    await expect(posts.resolveAmbiguous(scope, t.targetId, { outcome: "published" })).rejects.toBeInstanceOf(ForbiddenError);
    for (const input of [undefined, { mode: "now" }, { mode: "requeue" }, { mode: "at", at: "2026-10-07T15:00:00.000Z" }])
      await expect(posts.retryTarget(scope, t.targetId, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(previewRequeue(scope, t.targetId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a scope whose can() lacks post:schedule is refused, and sees View only actions", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    const stub = new Proxy(env.scope, {
      get: (target, prop, receiver) =>
        prop === "can" ? (req: { post?: string[] }) => !req.post?.includes("schedule") : Reflect.get(target, prop, receiver),
    });
    await expect(posts.resolveAmbiguous(stub, t.targetId, { outcome: "published" })).rejects.toBeInstanceOf(ForbiddenError);
    for (const input of [undefined, { mode: "now" }, { mode: "requeue" }, { mode: "at", at: "2026-10-07T15:00:00.000Z" }])
      await expect(posts.retryTarget(stub, t.targetId, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(previewRequeue(stub, t.targetId)).rejects.toBeInstanceOf(ForbiddenError);
    const [row] = (await listFailures(stub)).rows;
    expect(row!.actions).toMatchObject({ canMarkPublished: false, canRequeue: false, canMarkNotPublished: false, canRetry: false });
  });
});

describe("retry all failed — authorization and isolation", () => {
  it("non-members and another project's slug get not_found from both actions", async () => {
    const env = await postsEnv();
    const other = await postsEnv();
    const t = await outcomeTarget(env, "fatal");
    for (const user of [await createUser(), other.owner]) {
      actAs(user);
      expect(await failureActions.retryAllFailedAction(env.project.slug, { mode: "now" })).toMatchObject({ ok: false, error: "not_found" });
      expect(await failureActions.previewRetryAllAction(env.project.slug, {})).toMatchObject({ ok: false, error: "not_found" });
    }
    actAs(null);
    expect((await posts.getPost(env.scope, t.postId)).targets[0]!.status).toBe("failed");
  });

  it("a scope without post:schedule or a read-only key is refused and nothing changes", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "fatal");
    const stub = new Proxy(env.scope, {
      get: (target, prop, receiver) =>
        prop === "can" ? (req: { post?: string[] }) => !req.post?.includes("schedule") : Reflect.get(target, prop, receiver),
    });
    const key = await createKey(env.scope, ["read"]);
    const { scope: readOnly } = await forApiKey(key.secret);
    for (const s of [stub, readOnly]) {
      await expect(posts.retryAllFailed(s, { mode: "now" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(posts.previewRetryAll(s, {})).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await posts.getPost(env.scope, t.postId)).targets[0]!.status).toBe("failed");
  });

  it("a run in project 1 leaves project 2 untouched, with or without a foreign account filter", async () => {
    const one = await postsEnv();
    const two = await postsEnv();
    await outcomeTarget(one, "fatal");
    const foreign = await outcomeTarget(two, "fatal");
    const before = (await two.scope.targets.get(foreign.targetId))!;
    const attemptsBefore = await posts.listAttempts(two.scope, foreign.targetId);

    const plain = await atTime(LATER, () => posts.retryAllFailed(one.scope, { mode: "now" }));
    expect(plain).toMatchObject({ count: 1, inScope: 1 });
    const filtered = await atTime(LATER, () => posts.retryAllFailed(one.scope, { mode: "now", account: foreign.account.id }));
    expect(filtered.count).toBe(0);

    expect(await two.scope.targets.get(foreign.targetId)).toEqual(before);
    expect(await posts.listAttempts(two.scope, foreign.targetId)).toEqual(attemptsBefore);
  });
});
