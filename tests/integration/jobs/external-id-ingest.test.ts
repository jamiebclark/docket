import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ValidationIssuesError } from "../../../src/server/dal/errors";
import { setLlmForTests } from "../../../src/server/llm";
import { appendItems } from "../../../src/server/services/jobs/append";
import { createJob } from "../../../src/server/services/jobs/create";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { jobsEnv, parkAllJobs } from "../../helpers/jobs-env";
import { createDraftPost } from "../../helpers/scheduling";
import { ObservedQuery, queryObservers } from "../../../src/server/db/client";

beforeEach(parkAllJobs);
afterAll(async () => {
  setLlmForTests(null);
  setStorageForTests(undefined);
  await closeDb();
});

async function setup() {
  const env = await jobsEnv();
  setLlmForTests(createFakeLlm([]));
  const apiInput = (items: { fields: Record<string, string>; externalId?: string }[], open = true, sourceKey?: string) =>
    env.input({
      source: { kind: "api", fields: ["product"], open, items, ...(sourceKey ? { sourceKey } : {}) },
      template: "Announce {{product}}.",
    });
  const items = (ids: readonly string[]) => ids.map((id, i) => ({ fields: { product: `Widget ${i}` }, externalId: id }));
  /** Claims `id` for a freshly-inserted draft post, no model call. */
  const claim = async (id: string, sourceKey = "default") => {
    const { post } = await createDraftPost(env.project.id);
    await env.scope.externalClaims.insert({ sourceKey, externalId: id, postId: post.id, claimedAt: new Date() });
    return post.id;
  };
  return { ...env, apiInput, items, claim };
}

async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; queries: ObservedQuery[] }> {
  const queries: ObservedQuery[] = [];
  const obs = (q: ObservedQuery) => queries.push(q);
  queryObservers.add(obs);
  try {
    const result = await fn();
    return { result, queries };
  } finally {
    queryObservers.delete(obs);
  }
}

describe("external id ingest (US2)", () => {
  it("drops 10 already-posted items and adds 5 new ones on append (SC-002)", async () => {
    const e = await setup();
    const ids10 = Array.from({ length: 10 }, (_, i) => `rec-${i}`);
    for (const id of ids10) await e.claim(id);

    const job = await createJob(e.scope, e.apiInput([]));
    const ids15 = [...ids10, ...Array.from({ length: 5 }, (_, i) => `rec-new-${i}`)];
    const appended = await appendItems(e.scope, job.jobId, { items: e.items(ids15) });
    expect(appended).toMatchObject({ added: 5, skippedAlreadyPosted: 10, itemCount: 5 });
    expect((await e.scope.jobs.get(job.jobId))!.itemCount).toBe(5);
  });

  it("drops 10 already-posted items on create (SC-002)", async () => {
    const e = await setup();
    const ids10 = Array.from({ length: 10 }, (_, i) => `rec-${i}`);
    for (const id of ids10) await e.claim(id);
    const ids15 = [...ids10, ...Array.from({ length: 5 }, (_, i) => `rec-new-${i}`)];
    const created = await createJob(e.scope, e.apiInput(e.items(ids15), false));
    expect(created).toMatchObject({ itemCount: 5, skippedAlreadyPosted: 10 });
  });

  it("keeps one item when the same id appears twice in one call and counts one skipped (FR-017, AS2.3)", async () => {
    const e = await setup();
    const created = await createJob(
      e.scope,
      e.apiInput([{ fields: { product: "A" }, externalId: "dup" }, { fields: { product: "B" }, externalId: "dup" }], false),
    );
    expect(created).toMatchObject({ itemCount: 1, skippedAlreadyPosted: 1 });
  });

  it("refuses the whole call on an invalid item (FR-019)", async () => {
    const e = await setup();
    const created = await createJob(e.scope, e.apiInput(e.items(["rec-1"])));
    let caught: unknown;
    try {
      await appendItems(e.scope, created.jobId, { items: [{ fields: { product: "ok" } }, { fields: { product: "bad", colour: "x" } }] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationIssuesError);
    expect((await e.scope.jobs.get(created.jobId))!.itemCount).toBe(1);
  });

  it("accepts already-posted ids plus new ones without the skipped ids ever counting against the 500-item cap (FR-018, edge case)", async () => {
    const e = await setup();
    const job = await createJob(e.scope, e.apiInput([]));
    for (let batch = 0; batch < 5; batch++) {
      const ids = Array.from({ length: 100 }, (_, i) => `old-${batch}-${i}`);
      for (const id of ids) await e.claim(id);
      const r = await appendItems(e.scope, job.jobId, { items: e.items(ids) });
      expect(r).toMatchObject({ added: 0, skippedAlreadyPosted: 100 });
    }
    expect((await e.scope.jobs.get(job.jobId))!.itemCount).toBe(0);
    const fresh = await appendItems(e.scope, job.jobId, { items: e.items(["new-1", "new-2", "new-3"]) });
    expect(fresh).toMatchObject({ added: 3, skippedAlreadyPosted: 0, itemCount: 3 });
  }, 30_000);

  it("issues exactly one claim query for a 100-item append against ~1,000 pre-seeded claims, within budget (SC-008)", async () => {
    const e = await setup();
    for (let i = 0; i < 1000; i++) await e.claim(`seed-${i}`);

    const job = await createJob(e.scope, e.apiInput([]));
    const batch = e.items(Array.from({ length: 100 }, (_, i) => `fresh-${i}`));
    const t0 = Date.now();
    const { result, queries } = await capture(() => appendItems(e.scope, job.jobId, { items: batch }));
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(result).toMatchObject({ added: 100, skippedAlreadyPosted: 0 });
    const claimQueries = queries.filter((q) => q.sql.includes("external_item_claims"));
    expect(claimQueries).toHaveLength(1);
  }, 60_000);
});
