import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATIONS } from "../../../src/server/api/operations";
import { ObservedQuery, queryObservers } from "../../../src/server/db/client";
import { setStorageForTests } from "../../../src/server/storage";
import { ALL_PERMISSIONS, api, createKey, world } from "../../helpers/api";
import { call, FIXTURES } from "../../helpers/api-fixtures";
import { closeDb } from "../../helpers/db";
import { createMemoryStorage } from "../../helpers/storage";
import { shareStateWithinFile } from "../../setup/reset-database";

// `w` is one project pair built once and read by every test below; shared across the file.
shareStateWithinFile();

const KEYED = () => OPERATIONS.filter((op) => op.permission !== null);

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => {
  setStorageForTests(createMemoryStorage());
  w = await world();
});
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

it("has a fixture for every operation", () => {
  const missing = KEYED().filter((op) => !FIXTURES[op.id]).map((op) => op.id);
  expect(missing).toEqual([]);
  const known = new Set(OPERATIONS.map((o) => o.id));
  const stale = Object.keys(FIXTURES).filter((id) => !known.has(id) && !JOB_OPS.has(id));
  expect(stale).toEqual([]);
});

// Fixtures written ahead of the job operations (T062); they are checked once those exist.
const JOB_OPS = new Set(["listJobs", "createJob", "getJob", "listJobItems", "getJobItem", "addJobItems", "closeJob", "cancelJob", "retryFailedJobItems"]);

describe("authentication and permission, per operation", () => {
  it("answers 401 without a key, 403 naming the permission for a key without it, and neither with it", async () => {
    const lackingKeys = new Map<string, string>();
    const holderKeys = new Map<string, string>();
    for (const op of KEYED()) {
      const none = await call(op, w.a, undefined);
      expect(none.status, `${op.id} without a key`).toBe(401);

      const others = ALL_PERMISSIONS.filter((x) => x !== op.permission);
      if (!lackingKeys.has(op.permission!)) {
        lackingKeys.set(op.permission!, (await createKey(w.a.scope, others, { rateLimitPerMinute: 1000 })).secret);
        holderKeys.set(op.permission!, (await createKey(w.a.scope, [op.permission!], { rateLimitPerMinute: 1000 })).secret);
      }
      const lacking = lackingKeys.get(op.permission!)!;
      const denied = await call(op, w.a, lacking);
      expect(denied.status, `${op.id} without ${op.permission}`).toBe(403);
      expect(denied.json.error.code).toBe("missing_permission");
      expect(denied.json.error.details).toEqual({ permission: op.permission });
      expect(denied.json.error.message).toContain(op.permission);

      const holder = holderKeys.get(op.permission!)!;
      const allowed = await call(op, w.a, holder);
      expect([401, 403], `${op.id} with ${op.permission}`).not.toContain(allowed.status);
    }
  });
});

describe("recovery operations", () => {
  const RECOVERY = ["retryPostTarget", "resolvePostTarget", "retryFailedTargets"];

  it("refuses a read key with 403 naming write_posts and writes nothing", async () => {
    const ids = w.a.targets.map((t) => t.id);
    const snapshot = async () => ({
      attempts: (await w.a.scope.attempts.listForTargets(ids)).length,
      status: (await w.a.scope.targets.listForPost(w.a.post.id)).map((t) => t.status),
    });
    const before = await snapshot();
    for (const op of OPERATIONS.filter((o) => RECOVERY.includes(o.id))) {
      const r = await call(op, w.a, w.a.keys.read.secret);
      expect(r.status, op.id).toBe(403);
      expect(r.json.error.code).toBe("missing_permission");
      expect(r.json.error.details).toEqual({ permission: "write_posts" });
    }
    expect(await snapshot()).toEqual(before);
  });
});

describe("project isolation, per resource parameter", () => {
  it("answers another project's id exactly as it answers an unknown one", async () => {
    const key = w.a.keys.all.secret;
    const random = "00000000-0000-4000-8000-0000000000ab";
    const checked: string[] = [];
    for (const op of KEYED()) {
      for (const name of op.resourceParams ?? []) {
        const foreign: Record<string, string> = {
          postId: w.b.post.id,
          targetId: w.b.targets[0]!.id,
          mediaId: w.b.media.id,
          jobId: w.b.job.id,
          itemId: w.b.items[0]!.id,
          accountId: w.b.account.id,
          profileId: w.b.voiceProfile.id,
          slotId: w.b.slot!.id,
        };
        const other = await call(op, w.a, key, { [name]: foreign[name]! });
        const unknown = await call(op, w.a, key, { [name]: random });
        expect(other.status, `${op.id} ${name}`).toBe(404);
        const strip = (r: typeof other) => ({ code: r.json.error.code, message: r.json.error.message, details: r.json.error.details });
        expect(strip(other), `${op.id} ${name}`).toEqual(strip(unknown));
        checked.push(`${op.id}.${name}`);
      }
    }
    expect(checked.length).toBeGreaterThanOrEqual(6);
  });

  it("keeps the external id ledger per project (FR-012)", async () => {
    const claimedPost = await w.b.scope.posts.insert({ baseText: "Project B's post" });
    await w.b.scope.externalClaims.insert({ sourceKey: "default", externalId: "shared-id", postId: claimedPost.id, claimedAt: new Date() });
    expect(await w.a.scope.externalClaims.find("default", "shared-id")).toBeNull();
    expect(await w.b.scope.externalClaims.find("default", "shared-id")).toMatchObject({ postId: claimedPost.id });

    const queries: ObservedQuery[] = [];
    const obs = (q: ObservedQuery) => queries.push(q);
    queryObservers.add(obs);
    try {
      await w.a.scope.externalClaims.find("default", "shared-id");
      await w.a.scope.externalClaims.findMany("default", ["shared-id"]);
    } finally {
      queryObservers.delete(obs);
    }
    const claimQueries = queries.filter((q) => q.sql.includes("external_item_claims"));
    expect(claimQueries.length).toBeGreaterThan(0);
    for (const q of claimQueries) expect(q.sql, q.sql).toMatch(/project_id/);
  });

  it("never lists the other project's resources", async () => {
    const key = w.a.keys.all.secret;
    const media = (await api("GET", "/media?limit=100", { key })).json.data.map((m: { id: string }) => m.id);
    expect(media).toContain(w.a.media.id);
    expect(media).not.toContain(w.b.media.id);
    const accounts = (await api("GET", "/accounts", { key })).json.data.map((m: { id: string }) => m.id);
    expect(accounts).toEqual([w.a.account.id]);
  });
});
