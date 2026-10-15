import type { AnyApiOperation } from "../../src/server/api/operations";
import { api, world } from "./api";
import { jpeg } from "./images";

type Project = Awaited<ReturnType<typeof world>>["a"];

export interface Fixture {
  params?: (p: Project) => Record<string, string>;
  query?: string;
  body?: (p: Project) => unknown | Promise<unknown>;
}

const itemBody = { items: [{ fields: { product: "Mug" } }] };

/** One entry per operation id (FR-048). A new operation without an entry fails the "has a fixture" test. */
export const FIXTURES: Record<string, Fixture> = {
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
  updateSlot: { params: (p) => ({ slotId: p.slot!.id }), body: () => ({ paused: true }) },
  deleteSlot: { params: (p) => ({ slotId: p.slot!.id }) },
  setAccountPostingInstructions: { params: (p) => ({ accountId: p.account.id }), body: () => ({ instructions: "Scope test" }) },
};

export function fill(op: AnyApiOperation, params: Record<string, string>): string {
  return op.path.replace(/\{(\w+)\}/g, (_m, name: string) => params[name] ?? "00000000-0000-4000-8000-000000000000");
}

export async function call(op: AnyApiOperation, p: Project, key: string | undefined, override: Record<string, string> = {}) {
  const fx = FIXTURES[op.id]!;
  const params = { ...(fx.params?.(p) ?? {}), ...override };
  const body = fx.body ? await fx.body(p) : undefined;
  return api(op.method, `${fill(op, params)}${fx.query ? `?${fx.query}` : ""}`, { ...(key ? { key } : {}), ...(body !== undefined ? { body } : {}) });
}
