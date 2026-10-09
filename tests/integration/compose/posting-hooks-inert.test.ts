import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { providers } from "../../../src/providers/registry";
import type { PublishContext, SocialProvider } from "../../../src/providers/types";
import { runTick } from "../../../src/server/scheduler";
import * as posts from "../../../src/server/services/posts";
import * as accounts from "../../../src/server/services/accounts";
import { closeDb } from "../../helpers/db";
import { createProject } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";
import { blueskyLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

const contexts: PublishContext[] = [];
const seenNow: unknown[] = [];

// A provider with no `posting`, `consent` or `accountDetails`, recording what the engine hands it.
registerTestProvider({
  ...blueskyLikeProvider,
  key: "inert-hooks",
  displayName: "Inert hooks",
  accountNotes: (input) => {
    seenNow.push(input.now);
    return [];
  },
  advance: async (ctx) => {
    contexts.push(ctx);
    return { kind: "done", externalId: "x" };
  },
} as SocialProvider);

beforeEach(async () => {
  await parkAllDueTargets();
  contexts.length = 0;
  seenNow.length = 0;
});
afterAll(closeDb);

describe("G25–G28 hooks are inert for providers that do not use them", () => {
  it("declares none of the hooks on any registered provider except those that opt in", () => {
    for (const p of providers) {
      if (p.consent || p.accountDetails) expect(p.posting, p.key).toBeDefined();
    }
  });

  it("the composer check has null posting, null note and no summary notes", async () => {
    const env = await postsEnv();
    const account = await env.account();
    const check = await posts.checkComposition(env.scope, { baseText: "hello", targets: [{ accountId: account.id }] });
    const t = check.targets[0]!;
    expect(t.posting).toBeNull();
    expect(t.note).toBeNull();
    expect(t.requirements?.notes ?? []).toEqual([]);
    expect(t.issues.some((i) => i.field === "consent" || i.field.startsWith("posting"))).toBe(false);
  });

  it("saving posting values and consent for such a provider stores nothing", async () => {
    const env = await postsEnv();
    const account = await env.account();
    const draft = await posts.createDraft(env.scope, {
      baseText: "hello",
      targets: [{ accountId: account.id, posting: { v: 1, privacy: "SELF_ONLY" }, consent: { fingerprint: "v1:" + "a".repeat(64) } }],
    });
    const [target] = await env.scope.targets.listForPost(draft.post.id);
    expect(target!.postingFields).toBeNull();
    expect(target!.consentFingerprint).toBeNull();
    expect(target!.consentAt).toBeNull();
    const view = await posts.getPostView(env.scope, draft.post.id);
    expect(view.targets[0]!.note).toBeNull();
    const list = await posts.listPosts(env.scope);
    expect(list.items[0]!.targets[0]!.note).toBeNull();
  });

  it("the gate and the engine pass PostContent without `posting`", async () => {
    const project = await createProject();
    const account = await createMockAccount(project.id, {}, { providerKey: "inert-hooks" });
    await createDueTarget(project.id, account.id, { baseText: "plain" });
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ claimed: 1, done: 1 });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.content.posting).toBeUndefined();
  });

  it("accountNotes receives `now`, which providers may ignore", async () => {
    const env = await postsEnv();
    await accounts.saveConnectedAccount(env.scope, {
      providerKey: "inert-hooks",
      externalAccountId: "inert-1",
      displayName: "Inert",
      settings: {},
    });
    await accounts.listAccounts(env.scope);
    expect(seenNow.length).toBeGreaterThan(0);
    expect(seenNow.every((n) => n instanceof Date)).toBe(true);
  });
});
