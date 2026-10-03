import { afterAll, describe, expect, it, vi } from "vitest";

// Its own pool of 20, so 50 requests contend on real connections (SC-003). Set before the DB client is built.
vi.hoisted(() => {
  process.env.DATABASE_POOL_MAX = "20";
});

import { and, eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { postTargets } from "../../../src/server/db/schema";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const NOW = new Date("2026-10-01T12:00:00Z");
const REQUESTS = 50;
const RUNS = 20;

describe("queue concurrency (SC-003)", () => {
  it(`${REQUESTS} simultaneous addToQueue calls on one account get ${REQUESTS} distinct occurrences, ${RUNS} times`, async () => {
    for (let run = 0; run < RUNS; run++) {
      const env = await postsEnv();
      const a = await env.account();
      const drafts: Awaited<ReturnType<typeof posts.createDraft>>[] = [];
      for (let i = 0; i < REQUESTS; i++) drafts.push(await posts.createDraft(env.scope, { baseText: `p${i}`, targets: [{ accountId: a.id }] }));
      const results = await atTime(NOW, () => Promise.all(drafts.map((d) => posts.addToQueue(env.scope, d.post.id))));
      const instants = results.map((r) => {
        expect(r[0]).toMatchObject({ ok: true });
        return (r[0] as { scheduledAt: string }).scheduledAt;
      });
      expect(new Set(instants).size).toBe(REQUESTS);
      const rows = await getDb().select().from(postTargets).where(and(eq(postTargets.projectId, env.project.id), eq(postTargets.socialAccountId, a.id)));
      expect(new Set(rows.map((r) => r.slotOccurrenceAt!.getTime())).size).toBe(REQUESTS);
    }
  }, 300_000);

  it("the database refuses a second target on the same occurrence", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const p1 = await posts.createDraft(env.scope, { baseText: "1", targets: [{ accountId: a.id }] });
    const p2 = await posts.createDraft(env.scope, { baseText: "2", targets: [{ accountId: a.id }] });
    const [r1] = await atTime(NOW, () => posts.addToQueue(env.scope, p1.post.id));
    const held = new Date((r1 as { scheduledAt: string }).scheduledAt);
    const row = (await getDb().select().from(postTargets).where(and(eq(postTargets.projectId, env.project.id), eq(postTargets.id, p1.targets[0]!.id))))[0]!;
    await expect(
      getDb().update(postTargets).set({ slotOccurrenceAt: held, slotId: row.slotId, scheduleKind: "slot" }).where(and(eq(postTargets.projectId, env.project.id), eq(postTargets.id, p2.targets[0]!.id))),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });
});
