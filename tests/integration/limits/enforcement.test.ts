import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerPublishLimits } from "../../../src/providers/limits";
import { providers } from "../../../src/providers/registry";
import type { MediaItem, SocialProvider } from "../../../src/providers/types";
import { posts as postsTable, postTargets } from "../../../src/server/db/schema/posts";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";
import { validateResolvedContent } from "../../../src/server/services/posts/validate";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { createFakePds, mintJwt, type FakePds } from "../../helpers/fake-pds";
import { createProjectWithMembers } from "../../helpers/factories";
import { fakeSession } from "../../helpers/auth";
import { forProject } from "../../../src/server/dal/scope";
import { postsEnv } from "../../helpers/posts-env";
import { createDueTarget, createMockAccount, createSlots, parkAllDueTargets } from "../../helpers/scheduling";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";

/** Any request to a platform fails the test: every row below must be refused or deferred before one is made. */
const platformCalls: string[] = [];
beforeEach(async () => {
  await parkAllDueTargets();
  platformCalls.length = 0;
  vi.stubGlobal("fetch", (input: unknown) => {
    platformCalls.push(String(input instanceof Request ? input.url : input));
    return Promise.reject(new Error("a platform request was made"));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(platformCalls).toEqual([]);
});
afterAll(closeDb);

const BEFORE = new Date("2026-10-01T12:00:00Z");
const T0 = new Date("2026-10-05T09:00:00Z");

const image = (over: Partial<MediaItem> = {}): MediaItem => ({
  url: "http://localhost:3000/media/x.jpg",
  mimeType: "image/jpeg",
  width: 1000,
  height: 1000,
  bytes: 1000,
  altText: "",
  ...over,
});

/** Oversize files are compressed by the media planner, not refused (D15); the planner's own tests prove the edge. */
const COMPRESSES_OVERSIZE = new Set(["instagram", "threads"]);

/** The violating content for each capability field, derived from the provider's own values. */
function violations(provider: SocialProvider) {
  const { text, media, textOnlyAllowed } = provider.capabilities;
  const ok = image({ mimeType: media.allowedMimeTypes[0] ?? "image/jpeg" });
  const rows: { field: string; code: string; text: string; media: MediaItem[] }[] = [
    { field: "text length", code: "text_too_long", text: "a".repeat(text.maxLength + 1), media: media.required ? [ok] : [] },
  ];
  if (media.maxImages > 0) {
    rows.push({ field: "image count", code: "too_many_images", text: "hi", media: Array.from({ length: media.maxImages + 1 }, () => ok) });
    if (!COMPRESSES_OVERSIZE.has(provider.key)) {
      rows.push({ field: "bytes per file", code: "file_too_large", text: "hi", media: [{ ...ok, bytes: media.maxBytesPerFile + 1 }] });
    }
  }
  if (media.maxAltTextLength !== undefined) {
    rows.push({ field: "alt text", code: "alt_text_too_long", text: "hi", media: [{ ...ok, altText: "a".repeat(media.maxAltTextLength + 1) }] });
  }
  if (!textOnlyAllowed) rows.push({ field: "text-only", code: media.required ? "media_required" : "text_only_not_allowed", text: "hi", media: [] });
  return rows;
}

describe("capabilities are refused by the shared validation core (scheduling gate and publish engine)", () => {
  for (const provider of providers) {
    for (const row of violations(provider)) {
      it(`${provider.key}: ${row.field}`, () => {
        const issues = validateResolvedContent(provider, { text: row.text, media: row.media });
        expect(issues.map((i) => i.code)).toContain(row.code);
        expect(issues.find((i) => i.code === row.code)?.severity).toBe("error");
      });
    }
  }
});

describe("text rows: refused when scheduling and again at publish time, with no platform request (D14 a, b)", () => {
  for (const provider of providers) {
    const rows = violations(provider).filter((r) => r.media.length === 0 || r.field === "text length");
    for (const row of rows.filter((r) => r.field === "text length" || r.field === "text-only")) {
      if (row.media.length > 0) continue; // a media-required provider needs stored media; its text row is covered above
      it(`${provider.key}: ${row.field}`, async () => {
        const env = await createProjectWithMembers();
        const scope = await forProject(fakeSession(env.owner.id), env.project.slug);
        const account = await createMockAccount(env.project.id, {}, { providerKey: provider.key });
        await createSlots(env.project.id, account.id, [{ weekday: 1, localTime: "09:00" }]);

        // Before scheduling.
        const draft = await posts.createDraft(scope, { baseText: row.text, targets: [{ accountId: account.id }] });
        const queued = await atTime(BEFORE, () => posts.addToQueue(scope, draft.post.id, {}));
        expect(queued[0]).toMatchObject({ ok: false, code: "validation" });
        const issues = queued[0]!.ok ? [] : (queued[0]!.issues ?? []);
        expect(issues.map((i) => i.code)).toContain(row.code);

        // At publish time: scheduled while valid by the engine's view, content then past the limit.
        const { target } = await createDueTarget(env.project.id, account.id, { baseText: row.text, dueAt: new Date(T0.getTime() - 1000) });
        await atTime(T0, () => runTick());
        const after = await forSchedulerProject(env.project.id).targets.get(target.id);
        expect(after).toMatchObject({ status: "failed", externalId: null });
        expect(after!.lastError).toMatch(new RegExp(`^Can't publish to ${provider.displayName.replace(/[()]/g, "\\$&")}: `));
        const attempts = await forSchedulerProject(env.project.id).attempts.listForTarget(target.id);
        expect(attempts.map((a) => [a.step, a.outcome])).toEqual([["engine-validate", "fatal_error"]]);
      });
    }
  }
});

describe("publish limits defer without a platform request or a counted attempt (D14 c, D15)", () => {
  for (const provider of providers) {
    providerPublishLimits(provider).forEach((limit, index, all) => {
      it(`${provider.key}: ${limit.count} per ${limit.windowSeconds}s`, async () => {
        const env = await createProjectWithMembers();
        const account = await createMockAccount(env.project.id, {}, { providerKey: provider.key });
        // Start times sit inside this window but outside every shorter one, so only this limit is full.
        const shorter = all.filter((l) => l.windowSeconds < limit.windowSeconds).map((l) => l.windowSeconds);
        const ageSeconds = Math.max(0, ...shorter) + 600;
        const startedAt = new Date(T0.getTime() - ageSeconds * 1000);
        const db = testDb();
        for (let from = 0; from < limit.count; from += 1000) {
          const n = Math.min(1000, limit.count - from);
          const ids = await db
            .insert(postsTable)
            .values(Array.from({ length: n }, () => ({ projectId: env.project.id, baseText: "seed" })))
            .returning({ id: postsTable.id });
          await db.insert(postTargets).values(
            ids.map((p) => ({
              projectId: env.project.id,
              postId: p.id,
              socialAccountId: account.id,
              status: "failed" as const,
              publishStartedAt: startedAt,
            })),
          );
        }
        const { target } = await createDueTarget(env.project.id, account.id, { baseText: "hi", dueAt: new Date(T0.getTime() - 1000) });
        await atTime(T0, () => runTick({ config: { maxItems: 100 } }));
        const repos = forSchedulerProject(env.project.id);
        const after = await repos.targets.get(target.id);
        expect(after).toMatchObject({ status: "scheduled", attemptCount: 0 });
        expect(after!.nextAttemptAt!.getTime()).toBe(startedAt.getTime() + limit.windowSeconds * 1000);
        expect((await repos.attempts.listForTarget(target.id)).map((a) => a.outcome)).toEqual(["deferred"]);
      }, 60_000);
    });
  }
});

describe("Bluesky publishing does not create a session (FR-019)", () => {
  let pds: FakePds;
  const ACCESS = mintJwt(new Date("2030-01-01T01:00:00Z"));
  const REFRESH = mintJwt(new Date("2030-03-01T00:00:00Z"));
  const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
  const CID = "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgzmq2vz2m";

  it("connects once, then publishes three posts with createSession hit exactly once", async () => {
    pds = createFakePds();
    vi.stubGlobal("fetch", pds.fetch);
    pds.route("POST", "/xrpc/com.atproto.server.createSession", { json: { accessJwt: ACCESS, refreshJwt: REFRESH, did: DID, handle: "me.bsky.social" } });
    pds.route("POST", "/xrpc/com.atproto.repo.createRecord", { json: { uri: `at://${DID}/app.bsky.feed.post/3kabc`, cid: CID } });
    const env = await postsEnv();
    const out = await accounts.connectWithCredentials(env.scope, {
      providerKey: "bluesky",
      fields: { handle: "me.bsky.social", appPassword: "abcd-efgh-ijkl-mnop", pdsUrl: "" },
    });
    if (!out.ok) throw new Error("connect failed");
    for (let i = 0; i < 3; i++) await createDueTarget(env.project.id, out.account.id, { baseText: `post ${i}` });
    const counts = (await runTick({ config: { maxItems: 100 } })).publishing.counts;
    expect(counts.done).toBe(3);
    expect(pds.callsTo("POST", "/xrpc/com.atproto.server.createSession")).toHaveLength(1);
    expect(pds.callsTo("POST", "/xrpc/com.atproto.server.refreshSession")).toHaveLength(0);
    expect(pds.callsTo("POST", "/xrpc/com.atproto.repo.createRecord")).toHaveLength(3);
  });
});
