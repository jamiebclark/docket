import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../helpers/actions")).navigationModule);

import * as accountActions from "../../src/app/p/[projectSlug]/accounts/actions";
import * as calendarActions from "../../src/app/p/[projectSlug]/calendar/actions";
import * as reviewActions from "../../src/app/p/[projectSlug]/review/actions";
import * as generateActions from "../../src/app/p/[projectSlug]/generate/actions";
import * as composeActions from "../../src/app/p/[projectSlug]/compose/actions";
import * as mediaActions from "../../src/app/p/[projectSlug]/media/actions";
import * as uploadActions from "../../src/app/p/[projectSlug]/media/upload-actions";
import * as voiceActions from "../../src/app/p/[projectSlug]/voice/actions";
import * as postActions from "../../src/app/p/[projectSlug]/posts/actions";
import * as jobActions from "../../src/app/p/[projectSlug]/jobs/actions";
import * as apiKeyActions from "../../src/app/p/[projectSlug]/settings/api-keys/actions";
import { createApiKey } from "../../src/server/services/api-keys";
import { setLlmForTests } from "../../src/server/llm";
import { runTick } from "../../src/server/scheduler";
import { createJob } from "../../src/server/services/jobs";
import { startSeries } from "../../src/server/services/generation/series";
import { generateSingle } from "../../src/server/services/generation/single";
import * as posts from "../../src/server/services/posts";
import * as media from "../../src/server/services/media";
import { setStorageForTests } from "../../src/server/storage";
import { actAs, RedirectSignal } from "../helpers/actions";
import { atTime } from "../helpers/clock";
import { closeDb } from "../helpers/db";
import { createFakeLlm } from "../helpers/fake-llm";
import { createPostInReview, createSession, createUser, createVoiceProfile } from "../helpers/factories";
import { pageCandidate, readyAttempt, registerThrowaway, sessionFor, unregisterThrowaway } from "../helpers/connect-group";
import { png } from "../helpers/images";
import { postsEnv } from "../helpers/posts-env";
import { createMemoryStorage } from "../helpers/storage";
import { jobsEnv, parkAllJobs } from "../helpers/jobs-env";
import { createFakePds, mintJwt, type FakePds } from "../helpers/fake-pds";

beforeAll(registerThrowaway);
afterAll(async () => {
  unregisterThrowaway();
  setStorageForTests(undefined);
  await closeDb();
});
let pds: FakePds;
beforeEach(() => {
  pds = createFakePds().route("POST", "/xrpc/com.atproto.server.createSession", {
    json: {
      accessJwt: mintJwt(new Date("2030-01-01T00:00:00Z")),
      refreshJwt: mintJwt(new Date("2030-03-01T00:00:00Z")),
      did: "did:plc:authz",
      handle: "authz.bsky.social",
    },
  });
  vi.stubGlobal("fetch", pds.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setStorageForTests(undefined);
});

const NOW = new Date("2026-10-01T12:00:00Z");
type Env = Awaited<ReturnType<typeof postsEnv>>;
type Fx = Awaited<ReturnType<typeof fixtures>>;
type Role = "owner" | "admin" | "editor" | "nonMember";

const fakeOkPost = () => ({ ok: { variants: { mock: { text: "Generated text" } } } });

/** Fresh entities per call, so a destructive action in one row never starves the next. */
async function fixtures(env: Env) {
  const account = await env.account();
  const slots = await env.scope.slots.listForAccount(account.id);
  const queued = async (text: string) => {
    const p = await posts.createDraft(env.scope, { baseText: text, targets: [{ accountId: account.id }] });
    await atTime(NOW, () => posts.addToQueue(env.scope, p.post.id));
    return { postId: p.post.id, targetId: p.targets[0]!.id };
  };
  const a = await queued("one");
  const b = await queued("two");
  const draft = await posts.createDraft(env.scope, { baseText: "draft", targets: [{ accountId: account.id }] });
  const upload = await media.uploadMedia(env.scope, { file: { name: "a.png", bytes: await png() } });
  if (!upload.ok) throw new Error("fixture upload failed");
  const form = new FormData();
  form.set("file", new File([new Uint8Array(await png())], "b.png", { type: "image/png" }));
  const fakeOk = fakeOkPost;
  const voice = await createVoiceProfile(env.project.id);
  const generated = await generateSingle(
    env.scope,
    { requestId: randomUUID(), voiceProfileId: voice.id, brief: "Fixture", targetAccountIds: [account.id] },
    createFakeLlm([fakeOk()]),
  );
  if (!generated.ok) throw new Error("fixture generation failed");
  const reviewPosts = await Promise.all([1, 2, 3].map(() => createPostInReview(env.project.id, { accountIds: [account.id] })));
  // The actions under test use the configured provider; give each call its own scripted answers.
  setLlmForTests(createFakeLlm([fakeOk(), fakeOk()]));
  const attemptId = await readyAttempt(env.scope, await sessionFor(env.owner.id), pageCandidate("authz", "Authz", false));
  const apiKey = await createApiKey(env.scope, { name: "fixture", permissions: ["read"], rateLimitPerMinute: 60, expiry: "never" });
  return {
    attemptId,
    apiKeyId: apiKey.key.id,
    voiceProfileId: voice.id,
    seriesId: (
      await startSeries(env.scope, {
        voiceProfileId: voice.id,
        brief: "Series fixture",
        targetAccountIds: [account.id],
        count: 2,
        angles: [{ title: "One", description: "First" }],
      })
    ).seriesId,
    voiceVersionId: (await env.scope.voiceVersions.getByNumber(voice.id, 1))!.id,
    generatedPostId: generated.postId,
    reviewPostId: reviewPosts[0]!.post.id,
    reviewPostIds: [reviewPosts[1]!.post.id, reviewPosts[2]!.post.id],
    accountId: account.id,
    slotId: slots[0]!.id,
    targetId: a.targetId,
    targetIdB: b.targetId,
    postId: a.postId,
    draftId: draft.post.id,
    mediaId: upload.asset.id,
    form,
  };
}

type Case = { name: string; manage?: true; run: (slug: string, f: Fx) => Promise<unknown> };

const CASES: Case[] = [
  {
    name: "createApiKeyAction",
    manage: true,
    run: (s) => {
      const form = new FormData();
      form.set("name", `key-${randomUUID().slice(0, 8)}`);
      form.append("permissions", "read");
      form.set("rateLimitPerMinute", "60");
      form.set("expiry", "never");
      return apiKeyActions.createApiKeyAction(s, form);
    },
  },
  { name: "revokeApiKeyAction", manage: true, run: (s, f) => apiKeyActions.revokeApiKeyAction(s, f.apiKeyId) },
  {
    name: "createUploadAction",
    run: (s) => uploadActions.createUploadAction(s, { filename: "a.png", kind: "image", declaredType: "image/png", bytes: 100 }),
  },
  { name: "updateMediaAction", run: (s, f) => mediaActions.updateMediaAction(s, { id: f.mediaId, altText: "x" }) },
  { name: "deleteMediaImpactAction", run: (s, f) => mediaActions.deleteMediaImpactAction(s, { id: f.mediaId }) },
  { name: "deleteMediaAction", run: (s, f) => mediaActions.deleteMediaAction(s, { id: f.mediaId }) },
  { name: "saveDraftAction", run: (s, f) => composeActions.saveDraftAction(s, { baseText: "hi", mediaIds: [], targets: [{ accountId: f.accountId }] }) },
  { name: "previewQueueAction", run: (s, f) => composeActions.previewQueueAction(s, { postId: f.draftId }) },
  { name: "addToQueueAction", run: (s, f) => composeActions.addToQueueAction(s, { postId: f.draftId }) },
  { name: "previewExplicitTimeAction", run: (s, f) => composeActions.previewExplicitTimeAction(s, { postId: f.draftId, local: "2030-01-01T10:00" }) },
  { name: "scheduleAtAction", run: (s, f) => composeActions.scheduleAtAction(s, { postId: f.draftId, at: "2030-01-01T10:00:00Z" }) },
  { name: "publishNowAction", run: (s, f) => composeActions.publishNowAction(s, { postId: f.draftId }) },
  {
    name: "generateSingleAction",
    run: (s, f) =>
      generateActions.generateSingleAction(s, {
        requestId: randomUUID(),
        voiceProfileId: f.voiceProfileId,
        brief: "A brief",
        targetAccountIds: [f.accountId],
      }),
  },
  {
    name: "planSeriesAction",
    run: (s, f) => {
      setLlmForTests(createFakeLlm([{ ok: { angles: [{ title: "One", description: "First" }, { title: "Two", description: "Second" }] } }]));
      return generateActions.planSeriesAction(s, { voiceProfileId: f.voiceProfileId, brief: "A brief", targetAccountIds: [f.accountId], count: 2 });
    },
  },
  {
    name: "startSeriesAction",
    run: (s, f) =>
      generateActions.startSeriesAction(s, {
        voiceProfileId: f.voiceProfileId,
        brief: "A brief",
        targetAccountIds: [f.accountId],
        count: 2,
        angles: [{ title: "One", description: "First" }],
      }),
  },
  {
    name: "writeSeriesPostAction",
    run: (s, f) => {
      setLlmForTests(createFakeLlm([fakeOkPost()]));
      return generateActions.writeSeriesPostAction(s, { seriesId: f.seriesId, position: 0 });
    },
  },
  { name: "regenerateAction", run: (s, f) => generateActions.regenerateAction(s, { postId: f.generatedPostId, instruction: "Shorter" }) },
  { name: "approveAction", run: (s, f) => reviewActions.approveAction(s, { postId: f.reviewPostId }) },
  { name: "rejectAction", run: (s, f) => reviewActions.rejectAction(s, { postId: f.reviewPostId, reason: "No" }) },
  { name: "bulkApproveAction", run: (s, f) => reviewActions.bulkApproveAction(s, { postIds: f.reviewPostIds }) },
  {
    name: "updatePostVariantsAction",
    run: (s, f) => generateActions.updatePostVariantsAction(s, { postId: f.generatedPostId, edits: [{ accountIds: [f.accountId], text: "Edited" }] }),
  },
  { name: "createVoiceAction", manage: true, run: (s) => voiceActions.createVoiceAction(s, { name: `Voice ${randomUUID()}`, content: {} }) },
  {
    name: "saveVoiceAction",
    manage: true,
    run: (s, f) => voiceActions.saveVoiceAction(s, { profileId: f.voiceProfileId, name: "Edited voice", content: { audience: "All" }, baseVersion: 1 }),
  },
  { name: "setDefaultVoiceAction", manage: true, run: (s, f) => voiceActions.setDefaultVoiceAction(s, { profileId: f.voiceProfileId }) },
  { name: "archiveVoiceAction", manage: true, run: (s, f) => voiceActions.archiveVoiceAction(s, { profileId: f.voiceProfileId }) },
  { name: "restoreVoiceAction", manage: true, run: (s, f) => voiceActions.restoreVoiceAction(s, { profileId: f.voiceProfileId }) },
  {
    name: "tryVoiceAction",
    run: (s, f) => voiceActions.tryVoiceAction(s, { brief: "Say hi", providerKeys: ["mock"], versionId: f.voiceVersionId }),
  },
  { name: "retryTargetAction", run: (s, f) => postActions.retryTargetAction(s, { targetId: f.targetId }) },
  { name: "cancelTargetAction", run: (s, f) => postActions.cancelTargetAction(s, { targetId: f.targetId }) },
  {
    name: "resolveTargetAction",
    run: (s, f) => postActions.resolveTargetAction(s, { targetId: f.targetId, outcome: "not_published", requeue: false }),
  },
  { name: "previewRequeueAction", run: (s, f) => postActions.previewRequeueAction(s, { targetId: f.targetId }) },
  { name: "deletePostAction", run: (s, f) => postActions.deletePostAction(s, { postId: f.draftId }) },
  {
    name: "moveToOccurrenceAction",
    run: (s, f) => calendarActions.moveToOccurrenceAction(s, { targetId: f.targetId, slotId: f.slotId, scheduledAt: "2030-01-07T09:00:00Z" }),
  },
  { name: "moveToNextFreeAction", run: (s, f) => calendarActions.moveToNextFreeAction(s, { targetId: f.targetId }) },
  { name: "swapTargetsAction", run: (s, f) => calendarActions.swapTargetsAction(s, { targetIdA: f.targetId, targetIdB: f.targetIdB }) },
  { name: "listQueuedForAccountAction", run: (s, f) => calendarActions.listQueuedForAccountAction(s, { accountId: f.accountId }) },
  {
    name: "listEmptySlotsAction",
    run: (s, f) => calendarActions.listEmptySlotsAction(s, { accountId: f.accountId, from: "2030-01-01", to: "2030-01-31" }),
  },
  { name: "previewPullForwardAction", run: (s, f) => calendarActions.previewPullForwardAction(s, { accountId: f.accountId }) },
  { name: "pullForwardAction", run: (s, f) => calendarActions.pullForwardAction(s, { accountId: f.accountId, expected: [] }) },
  { name: "connectMockAction", manage: true, run: (s) => accountActions.connectMockAction(s, { displayName: "New mock" }) },
  {
    name: "connectCredentialsAction",
    manage: true,
    run: (s) =>
      accountActions.connectCredentialsAction(s, {
        providerKey: "bluesky",
        fields: { handle: "authz.bsky.social", appPassword: "authz-app-password-1", pdsUrl: "" },
      }),
  },
  { name: "startOAuthConnectAction", manage: true, run: (s) => accountActions.startOAuthConnectAction(s, { groupKey: "throwaway" }) },
  {
    name: "pasteConnectTokenAction (unavailable group)",
    manage: true,
    run: (s) => accountActions.pasteConnectTokenAction(s, { groupKey: "throwaway-strict", token: "T".repeat(20) }),
  },
  {
    name: "chooseConnectCandidatesAction",
    manage: true,
    run: (s, f) => accountActions.chooseConnectCandidatesAction(s, { attemptId: f.attemptId, selected: ["tw-page:authz"] }),
  },
  { name: "reconnectMockAction", manage: true, run: (s, f) => accountActions.reconnectMockAction(s, { id: f.accountId }) },
  { name: "setMockBehaviourAction", manage: true, run: (s, f) => accountActions.setMockBehaviourAction(s, { id: f.accountId, settings: {} }) },
  { name: "removeAccountAction", manage: true, run: (s, f) => accountActions.removeAccountAction(s, { id: f.accountId }) },
  { name: "accountRemovalImpactAction", run: (s, f) => accountActions.accountRemovalImpactAction(s, { id: f.accountId }) },
  { name: "addSlotAction", manage: true, run: (s, f) => accountActions.addSlotAction(s, { accountId: f.accountId, weekday: 3, localTime: "11:00" }) },
  { name: "setSlotPausedAction", manage: true, run: (s, f) => accountActions.setSlotPausedAction(s, { id: f.slotId, paused: true }) },
  { name: "deleteSlotAction", manage: true, run: (s, f) => accountActions.deleteSlotAction(s, { id: f.slotId }) },
];

const SECRET = /credentialsEncrypted|accessToken|refreshToken|secretAccessKey|S3_SECRET|"token"/i;

async function call(c: Case, slug: string, f: Fx): Promise<{ ok: boolean; error?: string; text: string }> {
  try {
    const r = (await atTime(NOW, () => c.run(slug, f))) as { ok: boolean; error?: string };
    return { ok: r.ok, error: r.error, text: JSON.stringify(r) };
  } catch (e) {
    // deletePostAction redirects on success.
    if (e instanceof RedirectSignal) return { ok: true, text: e.message };
    return { ok: false, error: "thrown", text: String(e instanceof Error ? e.message : e) };
  }
}

describe("every server action × role (SC-009, SC-011)", () => {
  it.each(CASES)("$name", async (c) => {
    setStorageForTests(createMemoryStorage());
    const env = await postsEnv();
    const outsider = await createUser();
    const who: Record<Role, { id: string }> = { owner: env.owner, admin: env.admin, editor: env.editor, nonMember: outsider };

    for (const role of ["nonMember", "editor", "admin", "owner"] as const) {
      actAs(who[role], (await createSession(who[role].id)).id);
      const f = await fixtures(env);
      const r = await call(c, env.project.slug, f);
      expect(r.text, `${c.name} as ${role} leaked a secret`).not.toMatch(SECRET);
      if (role === "nonMember") {
        expect(r.error, `${c.name} as nonMember`).toBe("not_found");
      } else if (role === "editor" && c.manage) {
        expect(r.error, `${c.name} as editor`).toBe("forbidden");
      } else {
        expect(r.error ?? "ok", `${c.name} as ${role}`).not.toMatch(/^(forbidden|not_found|unauthenticated|thrown)$/);
      }
    }
  }, 60_000);

  it("a signed-out caller is refused", async () => {
    setStorageForTests(createMemoryStorage());
    const env = await postsEnv();
    actAs(null);
    const r = await call(CASES.find((c) => c.name === "createUploadAction")!, env.project.slug, await fixtures(env));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^(not_found|unauthenticated)$/);
  });
});

describe("generate actions", () => {
  it("refuses an editor's auto-approve in the series actions with the policy message", async () => {
    const env = await postsEnv();
    const account = await env.account();
    const voice = await createVoiceProfile(env.project.id);
    actAs(env.editor, (await createSession(env.editor.id)).id);
    const r = await generateActions.startSeriesAction(env.project.slug, {
      voiceProfileId: voice.id,
      brief: "A brief",
      targetAccountIds: [account.id],
      count: 2,
      angles: [{ title: "One", description: "First" }],
      approval: "auto_approve",
    });
    expect(r).toMatchObject({ ok: false, error: "forbidden", message: "Only owners and admins can auto-approve" });
  });

  it("never put the LLM key in a result, even when the provider rejects it", async () => {
    const key = "sk-FAKE-authz-llm-key-0123456789";
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("LLM_MODEL", "fake-model");
    vi.stubEnv("OPENAI_API_KEY", key);
    setLlmForTests(null);
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${key}` } }), { status: 401 }),
    );
    try {
      const env = await postsEnv();
      const account = await env.account();
      const voice = await createVoiceProfile(env.project.id);
      actAs(env.owner, (await createSession(env.owner.id)).id);
      const r = await generateActions.generateSingleAction(env.project.slug, {
        requestId: randomUUID(),
        voiceProfileId: voice.id,
        brief: "A brief",
        targetAccountIds: [account.id],
      });
      expect(r).toMatchObject({ ok: true, data: { ok: false, kind: "auth" } });
      expect(JSON.stringify(r)).not.toContain(key);
      expect(JSON.stringify(await env.scope.generationFailures.listRecent(5))).not.toContain(key);
    } finally {
      vi.unstubAllEnvs();
      setLlmForTests(null);
    }
  });
});

describe("connectCredentialsAction", () => {
  it("makes no PDS request for an editor", async () => {
    const env = await postsEnv();
    actAs(env.editor);
    const r = await accountActions.connectCredentialsAction(env.project.slug, {
      providerKey: "bluesky",
      fields: { handle: "authz.bsky.social", appPassword: "authz-app-password-1", pdsUrl: "" },
    });
    expect(r).toMatchObject({ ok: false, error: "forbidden" });
    expect(pds.requests).toHaveLength(0);
  });

  it("lets owners and admins through, and never echoes field values", async () => {
    const env = await postsEnv();
    for (const who of [env.owner, env.admin]) {
      actAs(who);
      const r = await accountActions.connectCredentialsAction(env.project.slug, {
        providerKey: "bluesky",
        fields: { handle: "authz.bsky.social", appPassword: "authz-app-password-1", pdsUrl: "" },
      });
      expect(r.ok).toBe(true);
      expect(JSON.stringify(r)).not.toContain("authz-app-password-1");
    }
    expect(pds.requests).toHaveLength(2);
  });
});

describe("job actions (008)", () => {
  beforeEach(parkAllJobs);

  /** A job with one failed item (its image was deleted) and one queued item. */
  async function jobWithFailure() {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([]));
    await e.assets(2);
    const { jobId } = await createJob(e.scope, e.input());
    const [first] = await e.scope.jobItems.listForJob(jobId);
    await e.scope.media.softDelete(first!.mediaAssetId!, new Date());
    await runTick({ config: { jobMaxItems: 1 } });
    return { e, jobId, itemId: first!.id };
  }

  const create = (slug: string, e: Awaited<ReturnType<typeof jobsEnv>>, over: Record<string, unknown> = {}) => {
    const body = new FormData();
    body.set("payload", JSON.stringify(e.input(over)));
    return jobActions.createJobAction(slug, body);
  };

  it("lets an editor create, retry and cancel", async () => {
    const { e, jobId, itemId } = await jobWithFailure();
    actAs(e.editor, (await createSession(e.editor.id)).id);
    await e.assets(1, { tags: ["editor"] });
    await expect(create(e.project.slug, e)).rejects.toBeInstanceOf(RedirectSignal);
    expect(await jobActions.retryItemAction(e.project.slug, { jobId, itemId })).toMatchObject({ ok: true, data: { changed: true } });
    expect(await jobActions.retryFailedAction(e.project.slug, { jobId })).toMatchObject({ ok: true });
    expect(await jobActions.cancelJobAction(e.project.slug, { jobId })).toMatchObject({ ok: true, data: { changed: true } });
  }, 60_000);

  it("refuses an editor's auto-approve unless it is the project default", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([]));
    await e.assets(1);
    actAs(e.editor, (await createSession(e.editor.id)).id);
    const r = await create(e.project.slug, e, { approval: "auto_approve", scheduling: "leave_as_draft" });
    expect(r).toMatchObject({ ok: false, error: "forbidden", message: "Only owners and admins can auto-approve" });

    actAs(e.owner, (await createSession(e.owner.id)).id);
    await expect(create(e.project.slug, e, { approval: "auto_approve", scheduling: "leave_as_draft" })).rejects.toBeInstanceOf(RedirectSignal);
  }, 60_000);

  it("gives a non-member not-found for every action", async () => {
    const { e, jobId, itemId } = await jobWithFailure();
    const outsider = await createUser();
    actAs(outsider, (await createSession(outsider.id)).id);
    const slug = e.project.slug;
    const csv = new FormData();
    csv.set("file", new File(["a\n1\n"], "x.csv", { type: "text/csv" }));
    const results = [
      await create(slug, e),
      await jobActions.validateCsvAction(slug, csv),
      await jobActions.retryItemAction(slug, { jobId, itemId }),
      await jobActions.retryFailedAction(slug, { jobId }),
      await jobActions.cancelJobAction(slug, { jobId }),
    ];
    for (const r of results) expect(r).toMatchObject({ ok: false, error: "not_found" });
  }, 60_000);
});
