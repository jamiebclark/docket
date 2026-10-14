import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATIONS, type AnyApiOperation } from "../../../src/server/api/operations";
import { ObservedQuery, queryObservers } from "../../../src/server/db/client";
import { setStorageForTests } from "../../../src/server/storage";
import { ALL_PERMISSIONS, api, createKey, world } from "../../helpers/api";
import { closeDb } from "../../helpers/db";
import { jpeg } from "../../helpers/images";
import { createMemoryStorage } from "../../helpers/storage";

type Project = Awaited<ReturnType<typeof world>>["a"];

interface Fixture {
  params?: (p: Project) => Record<string, string>;
  query?: string;
  body?: (p: Project) => unknown | Promise<unknown>;
}

const itemBody = { items: [{ fields: { product: "Mug" } }] };

/** One entry per operation id (FR-048). A new operation without an entry fails the "has a fixture" test. */
const FIXTURES: Record<string, Fixture> = {
  listAccounts: {},
  listMedia: {},
  getMedia: { params: (p) => ({ mediaId: p.media.id }) },
  uploadMedia: {
    body: async () => {
      const f = new FormData();
      f.set("file", new File([new Uint8Array(await jpeg(50, 50))], "a.jpg", { type: "image/jpeg" }));
      return f;
    },
  },
  registerMediaFromUrl: { body: () => ({ url: "http://127.0.0.1:9/none.jpg" }) },
  createPost: { body: (p) => ({ text: "hi", accountIds: [p.account.id] }) },
  getPost: { params: (p) => ({ postId: p.post.id }) },
  getPostTarget: { params: (p) => ({ postId: p.post.id, targetId: p.targets[0]!.id }) },
  queuePost: { params: (p) => ({ postId: p.post.id }), body: () => ({}) },
  schedulePost: { params: (p) => ({ postId: p.post.id }), body: () => ({ at: "2030-01-01T10:00:00Z" }) },
  retryPostTarget: { params: (p) => ({ postId: p.post.id, targetId: p.targets[0]!.id }), body: () => ({ mode: "now" }) },
  resolvePostTarget: { params: (p) => ({ postId: p.post.id, targetId: p.targets[0]!.id }), body: () => ({ outcome: "not_published", requeue: false }) },
  retryFailedTargets: { body: () => ({ mode: "now" }) },
  generatePost: { body: (p) => ({ brief: "x", accountIds: [p.account.id] }) },
  listUpcomingSlots: {},
  listActivity: {},
  listJobs: {},
  createJob: { body: () => ({}) },
  getJob: { params: (p) => ({ jobId: p.job.id }) },
  listJobItems: { params: (p) => ({ jobId: p.job.id }) },
  getJobItem: { params: (p) => ({ jobId: p.job.id, itemId: p.items[0]!.id }) },
  addJobItems: { params: (p) => ({ jobId: p.job.id }), body: () => itemBody },
  closeJob: { params: (p) => ({ jobId: p.job.id }), body: () => ({}) },
  cancelJob: { params: (p) => ({ jobId: p.job.id }), body: () => ({}) },
  retryFailedJobItems: { params: (p) => ({ jobId: p.job.id }), body: () => ({}) },
  createProject: { body: () => ({ name: `P ${Math.random().toString(36).slice(2, 7)}`, slug: `p-${Math.random().toString(36).slice(2, 8)}`, timezone: "America/New_York" }) },
  createVoiceProfile: { body: () => ({ name: "Scope test", content: { voiceAndTone: "x" } }) },
  updateVoiceProfile: { params: (p) => ({ profileId: p.voiceProfile.id }), body: () => ({ name: "Scope test", content: { voiceAndTone: "x" }, baseVersion: 1 }) },
  addSlot: { body: (p) => ({ accountId: p.account.id, weekday: 6, localTime: "06:00" }) },
  addWeekSlots: { body: (p) => ({ accountId: p.account.id, localTime: "05:00" }) },
  updateSlot: { params: (p) => ({ slotId: p.slot.id }), body: () => ({ paused: true }) },
  deleteSlot: { params: (p) => ({ slotId: p.slot.id }) },
  setAccountPostingInstructions: { params: (p) => ({ accountId: p.account.id }), body: () => ({ instructions: "Scope test" }) },
};

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

function fill(op: AnyApiOperation, params: Record<string, string>): string {
  return op.path.replace(/\{(\w+)\}/g, (_m, name: string) => params[name] ?? "00000000-0000-4000-8000-000000000000");
}

async function call(op: AnyApiOperation, p: Project, key: string | undefined, override: Record<string, string> = {}) {
  const fx = FIXTURES[op.id]!;
  const params = { ...(fx.params?.(p) ?? {}), ...override };
  const body = fx.body ? await fx.body(p) : undefined;
  return api(op.method, `${fill(op, params)}${fx.query ? `?${fx.query}` : ""}`, { ...(key ? { key } : {}), ...(body !== undefined ? { body } : {}) });
}

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
          slotId: w.b.slot.id,
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
