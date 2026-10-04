import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import FailuresPage from "../../../src/app/p/[projectSlug]/failures/page";
import * as postActions from "../../../src/app/p/[projectSlug]/posts/actions";
import { forApiKey } from "../../../src/server/dal/scope";
import { ForbiddenError } from "../../../src/server/dal/errors";
import { listFailures, previewRequeue } from "../../../src/server/services/failures";
import * as posts from "../../../src/server/services/posts";
import { actAs, NotFoundSignal } from "../../helpers/actions";
import { createKey } from "../../helpers/api";
import { closeDb } from "../../helpers/db";
import { createUser } from "../../helpers/factories";
import { outcomeTarget } from "../../helpers/failures";
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
    await expect(posts.retryTarget(scope, t.targetId)).rejects.toBeInstanceOf(ForbiddenError);
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
    await expect(posts.retryTarget(stub, t.targetId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(previewRequeue(stub, t.targetId)).rejects.toBeInstanceOf(ForbiddenError);
    const [row] = (await listFailures(stub)).rows;
    expect(row!.actions).toMatchObject({ canMarkPublished: false, canRequeue: false, canMarkNotPublished: false, canRetry: false });
  });
});
