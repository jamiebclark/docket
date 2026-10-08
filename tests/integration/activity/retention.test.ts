import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { projects } from "../../../src/server/db/schema";
import { createActivityRepo } from "../../../src/server/dal/activity";
import * as accounts from "../../../src/server/services/accounts";
import { listProjectActivity } from "../../../src/server/services/activity";
import * as posts from "../../../src/server/services/posts";
import { eventsFor } from "../../helpers/activity";
import { closeDb, testDb } from "../../helpers/db";
import { outcomeTarget } from "../../helpers/failures";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(closeDb);

describe("history outlives what it describes", () => {
  it("keeps events when a post is deleted or an account removed, and labels them", async () => {
    const env = await postsEnv();
    const t = await outcomeTarget(env, "fatal");
    expect(await eventsFor(env.project.id)).toHaveLength(1);

    await posts.deletePost(env.scope, t.postId);
    let page = await listProjectActivity(env.scope, {});
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.post).toMatchObject({ id: t.postId, deleted: true, excerpt: "Hello" });

    await accounts.removeAccount(env.scope, t.account.id);
    page = await listProjectActivity(env.scope, {});
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.account).toMatchObject({ name: "Removed account", removed: true });
    expect(await eventsFor(env.project.id)).toHaveLength(1);
  });

  it("deleting a project removes its events", async () => {
    const env = await postsEnv();
    await outcomeTarget(env, "fatal");
    expect(await eventsFor(env.project.id)).toHaveLength(1);
    await runCrossProject("test: delete a project", () => testDb().delete(projects).where(eq(projects.id, env.project.id)));
    expect(await eventsFor(env.project.id)).toHaveLength(0);
  });

  it("the repo exposes no update or delete", async () => {
    const env = await postsEnv();
    const repo = createActivityRepo(testDb(), env.project.id);
    expect(Object.keys(repo).sort()).toEqual(["insert", "list", "summary"]);
  });
});
