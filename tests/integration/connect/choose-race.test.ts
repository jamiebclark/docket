import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import * as connect from "../../../src/server/services/connect";
import { closeDb, testDb } from "../../helpers/db";
import { pageCandidate, readyAttempt, registerThrowaway, sessionFor, unregisterThrowaway } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";

beforeAll(registerThrowaway);
afterAll(async () => {
  unregisterThrowaway();
  await closeDb();
});

describe("concurrent chooser submits", () => {
  it("lets only the first of two parallel submits save, 20 times", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    for (let i = 0; i < 20; i++) {
      const id = await readyAttempt(env.scope, session, pageCandidate(`${300 + i}`, `Page ${i}`, false));
      const selected = [`tw-page:${300 + i}`];
      const results = await Promise.all([
        connect.chooseConnectCandidates(env.scope, { attemptId: id, selected }, session),
        connect.chooseConnectCandidates(env.scope, { attemptId: id, selected }, session),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toHaveLength(1);
    }
    const rows = await testDb().select().from(socialAccounts).where(eq(socialAccounts.projectId, env.project.id));
    expect(rows).toHaveLength(20);
  });

  it("saves the same Page from two attempts without duplicating it", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    for (let i = 0; i < 5; i++) {
      const ext = `${900 + i}`;
      const a = await readyAttempt(env.scope, session, pageCandidate(ext, "Same", false));
      const b = await readyAttempt(env.scope, session, pageCandidate(ext, "Same", false));
      const selected = [`tw-page:${ext}`];
      const results = await Promise.all([
        connect.chooseConnectCandidates(env.scope, { attemptId: a, selected }, session),
        connect.chooseConnectCandidates(env.scope, { attemptId: b, selected }, session),
      ]);
      expect(results.every((r) => r.ok)).toBe(true);
    }
    const rows = await testDb().select().from(socialAccounts).where(eq(socialAccounts.projectId, env.project.id));
    expect(rows).toHaveLength(5);
  });
});
