import { afterAll, describe, expect, it } from "vitest";
import { OPERATIONS, type AnyApiOperation } from "../../../src/server/api/operations";
import * as slotsService from "../../../src/server/services/slots";
import * as voiceService from "../../../src/server/services/voice";
import * as projectsService from "../../../src/server/services/projects";
import { ALL_PERMISSIONS, api, createKey, world } from "../../helpers/api";
import { closeDb } from "../../helpers/db";

afterAll(closeDb);

type Project = Awaited<ReturnType<typeof world>>["a"];

interface Fixture {
  params?: (p: Project) => Record<string, string>;
  body?: (p: Project) => unknown;
}

/** Fixtures for the operations gated by `manage_setup` (FR-052). */
const SETUP_FIXTURES: Record<string, Fixture> = {
  createProject: { body: () => ({ name: `Nope ${Math.random().toString(36).slice(2, 7)}`, slug: `nope-${Math.random().toString(36).slice(2, 8)}`, timezone: "America/New_York" }) },
  createVoiceProfile: { body: () => ({ name: "Nope", content: { voiceAndTone: "x" } }) },
  updateVoiceProfile: { params: (p) => ({ profileId: p.voiceProfile.id }), body: () => ({ name: "Nope", content: { voiceAndTone: "x" }, baseVersion: 1 }) },
  addSlot: { body: (p) => ({ accountId: p.account.id, weekday: 5, localTime: "08:00" }) },
  addWeekSlots: { body: (p) => ({ accountId: p.account.id, localTime: "07:00" }) },
  updateSlot: { params: (p) => ({ slotId: p.slot!.id }), body: () => ({ paused: true }) },
  deleteSlot: { params: (p) => ({ slotId: p.slot!.id }) },
  setAccountPostingInstructions: { params: (p) => ({ accountId: p.account.id }), body: () => ({ instructions: "Nope" }) },
};

/** Every other keyed operation reuses a minimal body/params; these calls only need to reach the permission check. */
const OTHER_FIXTURES: Record<string, Fixture> = {
  listAccounts: {},
  listMedia: {},
  getMedia: { params: (p) => ({ mediaId: p.media.id }) },
  uploadMedia: {
    body: () => {
      const f = new FormData();
      f.set("file", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }), "a.jpg");
      return f;
    },
  },
  registerMediaFromUrl: { body: () => ({ url: "http://127.0.0.1:9/none.jpg" }) },
  createPost: { body: (p) => ({ text: "hi", accountIds: [p.account.id] }) },
  updatePost: { params: (p) => ({ postId: p.post.id }), body: () => ({ text: "edited" }) },
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
  getInsights: {},
  listJobs: {},
  createJob: { body: () => ({}) },
  getJob: { params: (p) => ({ jobId: p.job.id }) },
  listJobItems: { params: (p) => ({ jobId: p.job.id }) },
  getJobItem: { params: (p) => ({ jobId: p.job.id, itemId: p.items[0]!.id }) },
  addJobItems: { params: (p) => ({ jobId: p.job.id }), body: () => ({ items: [{ fields: { product: "Mug" } }] }) },
  closeJob: { params: (p) => ({ jobId: p.job.id }), body: () => ({}) },
  cancelJob: { params: (p) => ({ jobId: p.job.id }), body: () => ({}) },
  retryFailedJobItems: { params: (p) => ({ jobId: p.job.id }), body: () => ({}) },
};

function fill(op: AnyApiOperation, params: Record<string, string>): string {
  return op.path.replace(/\{(\w+)\}/g, (_m, name: string) => params[name] ?? "00000000-0000-4000-8000-000000000000");
}

async function call(op: AnyApiOperation, p: Project, key: string | undefined, fx: Fixture) {
  const params = fx.params?.(p) ?? {};
  const body = fx.body?.(p);
  return api(op.method, fill(op, params), { ...(key ? { key } : {}), ...(body !== undefined ? { body } : {}) });
}

const setupOps = () => OPERATIONS.filter((op) => op.permission === "manage_setup");
const otherKeyedOps = () => OPERATIONS.filter((op) => op.permission !== null && op.permission !== "manage_setup");

describe("manage_setup is its own boundary (FR-052)", () => {
  it("refuses a key with every other permission, and no key at all, without writing anything", async () => {
    const w = await world();
    const others = ALL_PERMISSIONS.filter((x) => x !== "manage_setup");
    const lacking = (await createKey(w.a.scope, others, { rateLimitPerMinute: 1000 })).secret;

    const snapshot = async () => ({
      slots: await slotsService.listSlots(w.a.scope, w.a.account.id),
      versions: await voiceService.listVersions(w.a.scope, w.a.voiceProfile.id),
      projects: await projectsService.listMine({ user: { id: w.a.owner.id } }),
    });
    const before = await snapshot();

    for (const op of setupOps()) {
      const fx = SETUP_FIXTURES[op.id];
      expect(fx, `missing fixture for ${op.id}`).toBeDefined();

      const none = await call(op, w.a, undefined, fx!);
      expect(none.status, `${op.id} without a key`).toBe(401);

      const denied = await call(op, w.a, lacking, fx!);
      expect(denied.status, `${op.id} without manage_setup`).toBe(403);
      expect(denied.json.error.code).toBe("missing_permission");
      expect(denied.json.error.details).toEqual({ permission: "manage_setup" });
      expect(denied.json.error.message).toContain("manage_setup");
    }

    expect(await snapshot()).toEqual(before);
  });

  it("refuses every pre-existing keyed operation to a key holding only manage_setup", async () => {
    const w = await world();
    const setupOnly = (await createKey(w.a.scope, ["manage_setup"], { rateLimitPerMinute: 1000 })).secret;

    for (const op of otherKeyedOps()) {
      const fx = OTHER_FIXTURES[op.id];
      expect(fx, `missing fixture for ${op.id}`).toBeDefined();

      const denied = await call(op, w.a, setupOnly, fx!);
      expect(denied.status, `${op.id} with only manage_setup`).toBe(403);
      expect(denied.json.error.code).toBe("missing_permission");
      expect(denied.json.error.details).toEqual({ permission: op.permission });
    }
  });
});
