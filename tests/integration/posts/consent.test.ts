import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { SocialProvider } from "../../../src/providers/types";
import { forApiKey } from "../../../src/server/dal/scope";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { clearAccountDetailsCache } from "../../../src/server/services/account-details";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";
import * as slots from "../../../src/server/services/slots";
import { createKey } from "../../helpers/api";
import { closeDb } from "../../helpers/db";
import { createProject } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";
import { blueskyLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

let advanced = 0;
let nickname = "Ada";

const provider = registerTestProvider({
  ...blueskyLikeProvider,
  key: "consent-test",
  displayName: "Consent test",
  advance: async () => {
    advanced++;
    return { kind: "done", externalId: "x" };
  },
  posting: {
    valuesSchema: z.object({ v: z.literal(1), mode: z.string() }),
    view: () => [],
  },
  consent: { declaration: (values) => `I agree (${(values as { mode: string } | null)?.mode ?? "none"})` },
  accountDetails: {
    schema: z.object({ nickname: z.string() }),
    read: async () => ({ ok: true, details: { nickname } }),
  },
} as SocialProvider);

const plain = registerTestProvider({ ...blueskyLikeProvider, key: "consent-free", displayName: "Consent free" } as SocialProvider);

beforeEach(async () => {
  await parkAllDueTargets();
  advanced = 0;
  nickname = "Ada";
  clearAccountDetailsCache();
});
afterAll(closeDb);

const REFUSAL = "Tick 'I agree' to post to Consent test.";
const values = { v: 1, mode: "public" };

async function setup(providerKey = provider.key) {
  const env = await postsEnv();
  const account = await accounts.saveConnectedAccount(env.scope, {
    providerKey,
    externalAccountId: `c-${Math.random().toString(36).slice(2, 8)}`,
    displayName: "Ada",
    settings: {},
    credentials: { token: "t" },
  });
  await slots.addSlot(env.scope, { accountId: account.id, weekday: 1, localTime: "09:00" });
  return { env, account };
}

type Env = Awaited<ReturnType<typeof setup>>["env"];

/** What the composer would send as the fingerprint for the current unsaved state. */
async function fingerprint(env: Env, accountId: string, baseText: string, posting: unknown = values) {
  const check = await posts.checkComposition(env.scope, { baseText, targets: [{ accountId, posting }] });
  return check.targets[0]!.posting!.consent!.fingerprint;
}

async function draftWith(env: Env, accountId: string, baseText = "hello", consent = true) {
  const fp = consent ? await fingerprint(env, accountId, baseText) : null;
  return posts.createDraft(env.scope, {
    baseText,
    targets: [{ accountId, posting: values, ...(fp ? { consent: { fingerprint: fp } } : {}) }],
  });
}

const FUTURE = () => new Date(Date.now() + 86_400_000).toISOString();

describe("consent gate (G27)", () => {
  it("refuses queueing, scheduling and publishing now without consent", async () => {
    const { env, account } = await setup();
    const draft = await draftWith(env, account.id, "hello", false);
    for (const run of [
      () => posts.addToQueue(env.scope, draft.post.id, {}),
      () => posts.scheduleAt(env.scope, draft.post.id, { at: FUTURE() }),
      () => posts.publishNow(env.scope, draft.post.id),
    ]) {
      const [result] = await run();
      expect(result).toMatchObject({ ok: false, code: "validation", message: REFUSAL });
    }
  });

  it("the composer check blocks until the fingerprint is agreed, and reports the declaration", async () => {
    const { env, account } = await setup();
    const before = (await posts.checkComposition(env.scope, { baseText: "hi", targets: [{ accountId: account.id, posting: values }] })).targets[0]!;
    expect(before.canSchedule).toBe(false);
    expect(before.issues.some((i) => i.code === "consent_required")).toBe(true);
    expect(before.posting!.consent).toMatchObject({ declaration: "I agree (public)", agreed: false });
    const fp = before.posting!.consent!.fingerprint;
    const after = (await posts.checkComposition(env.scope, { baseText: "hi", targets: [{ accountId: account.id, posting: values, consent: { fingerprint: fp } }] })).targets[0]!;
    expect(after.posting!.consent!.agreed).toBe(true);
    expect(after.canSchedule).toBe(true);
    const edited = (await posts.checkComposition(env.scope, { baseText: "hi!", targets: [{ accountId: account.id, posting: values, consent: { fingerprint: fp } }] })).targets[0]!;
    expect(edited.posting!.consent!.agreed).toBe(false);
  });

  it("records user, time, fingerprint and details on save, then lets the post go", async () => {
    const { env, account } = await setup();
    const draft = await draftWith(env, account.id);
    const [target] = await env.scope.targets.listForPost(draft.post.id);
    expect(target).toMatchObject({ consentByUserId: env.owner.id, consentDetails: { nickname: "Ada" }, postingFields: values });
    expect(target!.consentAt).toBeInstanceOf(Date);
    expect(target!.consentFingerprint).toMatch(/^v1:[0-9a-f]{64}$/);
    const [result] = await posts.scheduleAt(env.scope, draft.post.id, { at: FUTURE() });
    expect(result).toMatchObject({ ok: true });
  });

  it("editing the text, or a posting value, makes the consent go; a draft clears it", async () => {
    const { env, account } = await setup();
    const bodies = [{ baseText: "changed" }, { targets: [{ accountId: account.id, posting: { v: 1, mode: "private" } }] }];
    for (const body of bodies) {
      const draft = await draftWith(env, account.id);
      await posts.updatePost(env.scope, draft.post.id, body);
      const [target] = await env.scope.targets.listForPost(draft.post.id);
      expect(target!.consentFingerprint).toBeNull();
      const [result] = await posts.publishNow(env.scope, draft.post.id);
      expect(result).toMatchObject({ ok: false, message: REFUSAL });
    }
  });

  it("refuses an edit to a scheduled target without fresh consent", async () => {
    const { env, account } = await setup();
    const draft = await draftWith(env, account.id);
    await posts.scheduleAt(env.scope, draft.post.id, { at: FUTURE() });
    await expect(posts.updatePost(env.scope, draft.post.id, { baseText: "edited after scheduling" })).rejects.toThrow();
    const fp = await fingerprint(env, account.id, "edited again");
    await posts.updatePost(env.scope, draft.post.id, {
      baseText: "edited again",
      targets: [{ accountId: account.id, posting: values, consent: { fingerprint: fp } }],
    });
  });

  it("ignores an API key's consent", async () => {
    const { env, account } = await setup();
    const { secret } = await createKey(env.scope, ["read", "write_posts"]);
    const { scope } = await forApiKey(secret);
    const fp = await fingerprint(env, account.id, "via api");
    const draft = await posts.createDraft(scope, {
      baseText: "via api",
      targets: [{ accountId: account.id, posting: values, consent: { fingerprint: fp } }],
    });
    const [target] = await env.scope.targets.listForPost(draft.post.id);
    expect(target!.consentFingerprint).toBeNull();
  });

  it("starts a new post with no consent", async () => {
    const { env, account } = await setup();
    await draftWith(env, account.id);
    const second = await draftWith(env, account.id, "hello", false);
    const [target] = await env.scope.targets.listForPost(second.post.id);
    expect(target!.consentFingerprint).toBeNull();
  });

  it("a provider without consent is unaffected", async () => {
    const { env, account } = await setup(plain.key);
    const draft = await posts.createDraft(env.scope, { baseText: "free", targets: [{ accountId: account.id }] });
    const [result] = await posts.publishNow(env.scope, draft.post.id);
    expect(result).toMatchObject({ ok: true });
  });
});

describe("consent in the engine (G27)", () => {
  it("refuses a target whose consent went stale after scheduling, before any provider call", async () => {
    const project = await createProject();
    const account = await createMockAccount(project.id, {}, { providerKey: provider.key });
    const { target } = await createDueTarget(project.id, account.id, {
      baseText: "stale",
      patch: {
        postingFields: values,
        consentAt: new Date(),
        consentFingerprint: "v1:" + "0".repeat(64),
        consentDetails: { nickname: "Ada" },
      },
    });
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts.claimed).toBe(1);
    expect(advanced).toBe(0);
    const row = await forSchedulerProject(project.id).targets.get(target.id);
    expect(row).toMatchObject({ status: "failed" });
    expect(row!.lastError).toContain("No consent recorded for this Consent test post; nothing was posted.");
  });

  it("publishes a target whose consent still matches", async () => {
    const { env, account } = await setup();
    const draft = await draftWith(env, account.id);
    const [result] = await posts.publishNow(env.scope, draft.post.id);
    expect(result).toMatchObject({ ok: true });
    await runTick({ config: {} });
    expect(advanced).toBeGreaterThan(0);
  });
});
