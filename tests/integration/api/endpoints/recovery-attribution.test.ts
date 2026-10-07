import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runCrossProject } from "../../../../src/server/db/cross-project";
import { apiKeys, member, postTargets, publishAttempts, user, webhookEvents } from "../../../../src/server/db/schema";
import { toAttemptViews } from "../../../../src/server/services/failures";
import { revokeApiKey } from "../../../../src/server/services/api-keys";
import * as posts from "../../../../src/server/services/posts";
import { api, createKey } from "../../../helpers/api";
import { atTime } from "../../../helpers/clock";
import { closeDb, testDb } from "../../../helpers/db";
import { LATER, outcomeTarget } from "../../../helpers/failures";
import { failedTarget } from "../../../helpers/retry";
import { parkAllDueTargets } from "../../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(closeDb);

type Failed = Awaited<ReturnType<typeof failedTarget>>;

async function setup(opts: { name?: string; creator?: "owner" | "admin" } = {}) {
  const f = await failedTarget();
  const keyScope = opts.creator === "admin" ? await f.env.as(f.env.admin) : f.env.scope;
  const key = await createKey(keyScope, ["read", "write_posts"], { name: opts.name ?? "Bot", rateLimitPerMinute: 1000 });
  const retry = () =>
    atTime(LATER, () => api("POST", `/posts/${f.postId}/targets/${f.targetId}/retry`, { key: key.secret, body: { mode: "now" }, idem: crypto.randomUUID() }));
  return { ...f, key, retry };
}

// The scope recorder wants every query on a project-owned table filtered by project.
const targetRow = async (pid: string, id: string) =>
  (await testDb().select().from(postTargets).where(and(eq(postTargets.projectId, pid), eq(postTargets.id, id))))[0]!;
const attemptRows = (pid: string, id: string) =>
  testDb().select().from(publishAttempts).where(and(eq(publishAttempts.projectId, pid), eq(publishAttempts.postTargetId, id)));
const creatorOf = (f: Failed) => f.env.owner.id;

async function resolveVia(f: Failed, key: string) {
  const amb = await outcomeTarget(f.env, "ambiguous");
  const r = await atTime(LATER, () =>
    api("POST", `/posts/${amb.postId}/targets/${amb.targetId}/resolve`, {
      key,
      body: { outcome: "not_published", requeue: false },
      idem: crypto.randomUUID(),
    }),
  );
  return { amb, r };
}

describe("API attribution", () => {
  it("retry records the key and the creator's user id on the attempt", async () => {
    const s = await setup();
    const r = await s.retry();
    expect(r.status).toBe(200);
    const mine = (await attemptRows(s.env.project.id, s.targetId)).filter((a) => a.actorApiKeyId);
    expect(mine.length).toBeGreaterThan(0);
    for (const a of mine) {
      expect(a.actorApiKeyId).toBe(s.key.id);
      expect(a.actorUserId).toBe(creatorOf(s));
    }
  });

  it("resolve records the key and the creator's user id on the target and attempt", async () => {
    const s = await setup();
    const { amb, r } = await resolveVia(s, s.key.secret);
    expect(r.status).toBe(200);
    const t = await targetRow(s.env.project.id, amb.targetId);
    expect(t.resolvedByApiKeyId).toBe(s.key.id);
    expect(t.resolvedByUserId).toBe(creatorOf(s));
    const entry = (await attemptRows(s.env.project.id, amb.targetId)).find((a) => a.outcome === "resolved_failed");
    expect(entry).toMatchObject({ actorApiKeyId: s.key.id, actorUserId: creatorOf(s) });
  });

  it("keeps the user id when the creator has left the project", async () => {
    const s = await setup();
    await runCrossProject("test: creator leaves", () =>
      testDb().delete(member).where(and(eq(member.organizationId, s.env.project.id), eq(member.userId, creatorOf(s)))),
    );
    const r = await s.retry();
    expect(r.status).toBe(200);
    const mine = (await attemptRows(s.env.project.id, s.targetId)).filter((a) => a.actorApiKeyId);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((a) => a.actorUserId === creatorOf(s))).toBe(true);
  });

  it("records a null user id, not an empty string or a 500, when the creator's user row is gone", async () => {
    const s = await setup({ creator: "admin" });
    await runCrossProject("test: creator deleted", () => testDb().delete(user).where(eq(user.id, s.env.admin.id)));
    const r = await s.retry();
    expect(r.status).toBe(200);
    const mine = (await attemptRows(s.env.project.id, s.targetId)).filter((a) => a.actorApiKeyId);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((a) => a.actorUserId === null)).toBe(true);

    const { amb, r: resolved } = await resolveVia(s, s.key.secret);
    expect(resolved.status).toBe(200);
    const t = await targetRow(s.env.project.id, amb.targetId);
    expect(t.resolvedByApiKeyId).toBe(s.key.id);
    expect(t.resolvedByUserId).toBeNull();
  });

  it("reads 'API key {name}' before and after revoke and after expiry", async () => {
    const s = await setup({ name: "Nightly bot" });
    expect((await s.retry()).status).toBe(200);
    const names = async () =>
      (await toAttemptViews(s.env.scope, await attemptRows(s.env.project.id, s.targetId))).flatMap((e) => (e.actor.kind === "api_key" ? [e.actor.name] : []));
    expect(await names()).toContain("Nightly bot");

    await revokeApiKey(s.env.scope, s.key.id);
    expect(await names()).toContain("Nightly bot");

    await runCrossProject("test: expire key", () => testDb().update(apiKeys).set({ expiresAt: new Date("2020-01-01T00:00:00Z") }).where(and(eq(apiKeys.projectId, s.env.project.id), eq(apiKeys.id, s.key.id))));
    expect(await names()).toContain("Nightly bot");
  });

  it("a member-scope action writes no key", async () => {
    const f = await failedTarget();
    await atTime(LATER, () => posts.retryTarget(f.env.scope, f.targetId, { mode: "now" }));
    const mine = await attemptRows(f.env.project.id, f.targetId);
    expect(mine.every((a) => a.actorApiKeyId === null)).toBe(true);
    expect(mine.some((a) => a.actorUserId === f.env.owner.id)).toBe(true);

    const amb = await outcomeTarget(f.env, "ambiguous");
    await atTime(LATER, () => posts.resolveAmbiguous(f.env.scope, amb.targetId, { outcome: "not_published", requeue: false }));
    const t = await targetRow(f.env.project.id, amb.targetId);
    expect(t.resolvedByApiKeyId).toBeNull();
    expect(t.resolvedByUserId).toBe(f.env.owner.id);
  });
});

describe("API and member service parity (SC-005)", () => {
  const scrub = (o: Record<string, unknown>) => {
    const drop = new Set([
      "id", "postId", "postTargetId", "accountId", "socialAccountId", "createdAt", "updatedAt", "at", "resolvedAt", "scheduledAt", "slotId",
      "resolvedByUserId", "resolvedByApiKeyId", "actorUserId", "actorApiKeyId", "projectId", "nextPollAt", "lastAttemptAt", "durationMs", "tickId",
    ]);
    return Object.fromEntries(Object.entries(o).filter(([k, v]) => !drop.has(k) && !(v instanceof Date)));
  };
  const eventTypes = async (projectId: string) =>
    (await testDb().select().from(webhookEvents).where(eq(webhookEvents.projectId, projectId))).map((e) => e.type).sort();

  it("retry gives the same rows, attempts and events either way", async () => {
    const viaApi = await setup();
    const viaMember = await failedTarget();
    expect((await viaApi.retry()).status).toBe(200);
    await atTime(LATER, () => posts.retryTarget(viaMember.env.scope, viaMember.targetId, { mode: "now" }));

    expect(scrub(await targetRow(viaApi.env.project.id, viaApi.targetId))).toEqual(scrub(await targetRow(viaMember.env.project.id, viaMember.targetId)));
    const entries = async (pid: string, id: string) => (await attemptRows(pid, id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(scrub);
    expect(await entries(viaApi.env.project.id, viaApi.targetId)).toEqual(await entries(viaMember.env.project.id, viaMember.targetId));
    expect(await eventTypes(viaApi.env.project.id)).toEqual(await eventTypes(viaMember.env.project.id));
  });

  it("resolve gives the same rows, attempts and events either way", async () => {
    const viaApi = await setup();
    const viaMember = await failedTarget();
    const a = await resolveVia(viaApi, viaApi.key.secret);
    expect(a.r.status).toBe(200);
    const m = await outcomeTarget(viaMember.env, "ambiguous");
    await atTime(LATER, () => posts.resolveAmbiguous(viaMember.env.scope, m.targetId, { outcome: "not_published", requeue: false }));

    expect(scrub(await targetRow(viaApi.env.project.id, a.amb.targetId))).toEqual(scrub(await targetRow(viaMember.env.project.id, m.targetId)));
    const entries = async (pid: string, id: string) => (await attemptRows(pid, id)).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).map(scrub);
    expect(await entries(viaApi.env.project.id, a.amb.targetId)).toEqual(await entries(viaMember.env.project.id, m.targetId));
    expect(await eventTypes(viaApi.env.project.id)).toEqual(await eventTypes(viaMember.env.project.id));
  });
});
