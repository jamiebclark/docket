import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../helpers/actions")).navigationModule);

import * as accountActions from "../../src/app/p/[projectSlug]/accounts/actions";
import * as calendarActions from "../../src/app/p/[projectSlug]/calendar/actions";
import * as composeActions from "../../src/app/p/[projectSlug]/compose/actions";
import * as mediaActions from "../../src/app/p/[projectSlug]/media/actions";
import * as postActions from "../../src/app/p/[projectSlug]/posts/actions";
import * as posts from "../../src/server/services/posts";
import * as media from "../../src/server/services/media";
import { setStorageForTests } from "../../src/server/storage";
import { actAs, RedirectSignal } from "../helpers/actions";
import { atTime } from "../helpers/clock";
import { closeDb } from "../helpers/db";
import { createSession, createUser } from "../helpers/factories";
import { pageCandidate, readyAttempt, registerThrowaway, sessionFor, unregisterThrowaway } from "../helpers/connect-group";
import { png } from "../helpers/images";
import { postsEnv } from "../helpers/posts-env";
import { createMemoryStorage } from "../helpers/storage";
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
  const attemptId = await readyAttempt(env.scope, await sessionFor(env.owner.id), pageCandidate("authz", "Authz", false));
  return {
    attemptId,
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
  { name: "uploadMediaAction", run: (s, f) => mediaActions.uploadMediaAction(s, f.form) },
  { name: "updateMediaAction", run: (s, f) => mediaActions.updateMediaAction(s, { id: f.mediaId, altText: "x" }) },
  { name: "deleteMediaImpactAction", run: (s, f) => mediaActions.deleteMediaImpactAction(s, { id: f.mediaId }) },
  { name: "deleteMediaAction", run: (s, f) => mediaActions.deleteMediaAction(s, { id: f.mediaId }) },
  { name: "saveDraftAction", run: (s, f) => composeActions.saveDraftAction(s, { baseText: "hi", mediaIds: [], targets: [{ accountId: f.accountId }] }) },
  { name: "previewQueueAction", run: (s, f) => composeActions.previewQueueAction(s, { postId: f.draftId }) },
  { name: "addToQueueAction", run: (s, f) => composeActions.addToQueueAction(s, { postId: f.draftId }) },
  { name: "previewExplicitTimeAction", run: (s, f) => composeActions.previewExplicitTimeAction(s, { postId: f.draftId, local: "2030-01-01T10:00" }) },
  { name: "scheduleAtAction", run: (s, f) => composeActions.scheduleAtAction(s, { postId: f.draftId, at: "2030-01-01T10:00:00Z" }) },
  { name: "publishNowAction", run: (s, f) => composeActions.publishNowAction(s, { postId: f.draftId }) },
  { name: "retryTargetAction", run: (s, f) => postActions.retryTargetAction(s, { targetId: f.targetId }) },
  { name: "cancelTargetAction", run: (s, f) => postActions.cancelTargetAction(s, { targetId: f.targetId }) },
  { name: "resolveTargetAction", run: (s, f) => postActions.resolveTargetAction(s, { targetId: f.targetId, outcome: "failed" }) },
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
    const r = await call(CASES[0]!, env.project.slug, await fixtures(env));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^(not_found|unauthenticated)$/);
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
