import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError } from "../../../src/server/dal/errors";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { LATER, outcomeTarget } from "../../helpers/failures";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  await closeDb();
});

const resolve = (env: Awaited<ReturnType<typeof postsEnv>>, id: string, input: unknown) =>
  atTime(LATER, () => posts.resolveAmbiguous(env.scope, id, input));

describe("mark published", () => {
  it("records the link, re-derives the post and clears the error", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    expect(await resolve(env, t.targetId, { outcome: "published", url: "https://example.test/p/1" })).toEqual({ status: "published" });
    const after = await posts.getPost(env.scope, t.postId);
    expect(after.targets[0]).toMatchObject({ status: "published", externalUrl: "https://example.test/p/1", lastError: null });
    expect(after.post.status).toBe("published");
  });

  it("works without a link", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    await resolve(env, t.targetId, { outcome: "published" });
    expect((await posts.getPost(env.scope, t.postId)).targets[0]).toMatchObject({ status: "published", externalUrl: null });
  });

  it.each(["javascript:alert(1)", "ftp://example.test/x", "https://user:pw@example.test/x", "not a url"])("refuses %s with a url field error", async (url) => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    const err = await resolve(env, t.targetId, { outcome: "published", url }).catch((e: unknown) => e);
    expect((err as { name?: string }).name).toBe("ZodError");
    expect((err as { issues: { path: PropertyKey[] }[] }).issues[0]!.path).toEqual(["url"]);
    expect((await posts.getPost(env.scope, t.postId)).targets[0]!.status).toBe("ambiguous");
  });

  it("a second resolution loses with a conflict", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    await resolve(env, t.targetId, { outcome: "published" });
    await expect(resolve(env, t.targetId, { outcome: "published" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("is forbidden to a viewer without post:schedule", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "ambiguous");
    const stub = new Proxy(env.scope, {
      get: (target, prop, receiver) =>
        prop === "can" ? (req: { post?: string[] }) => !req.post?.includes("schedule") : Reflect.get(target, prop, receiver),
    });
    await expect(posts.resolveAmbiguous(stub, t.targetId, { outcome: "published" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
