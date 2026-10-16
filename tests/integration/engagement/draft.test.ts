import { afterAll, afterEach, describe, expect, it } from "vitest";
import { setLlmForTests } from "../../../src/server/llm";
import { requestDraft, writeReply, editDraft } from "../../../src/server/services/engagement/draft";
import * as projectsService from "../../../src/server/services/projects";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { createVoiceProfile } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterEach(() => setLlmForTests(null));
afterAll(async () => {
  await closeDb();
});

async function seedItem(scope: Awaited<ReturnType<typeof postsEnv>>["scope"], accountId: string, text = "Great post!") {
  const { id } = await scope.engagementItems.insertIfAbsent({
    socialAccountId: accountId,
    providerKey: "mock",
    kind: "reply",
    externalId: "ext-1",
    text,
    authorDisplayName: "Ada",
    authorHandle: "ada",
    authorExternalId: "ada-1",
    authorUrl: null,
    authorIdentityStable: true,
    saidAt: new Date("2026-01-01T00:00:00Z"),
    ingestedAt: new Date("2026-01-01T00:00:01Z"),
    parentExternalId: null,
  });
  return id;
}

async function setBrand(scope: { project: { id: string; slug: string; name: string; timezone: string } }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await projectsService.updateSettings(scope as any, {
    name: scope.project.name,
    slug: scope.project.slug,
    timezone: scope.project.timezone,
    defaultApprovalPolicy: "review_required",
    defaultSchedulingPolicy: "leave_as_draft",
    confirmUnreviewedQueue: false,
    tagline: "Fresh bread daily",
    description: "A neighbourhood bakery.",
    websiteUrl: "https://bakery.example",
  });
}

describe("requestDraft (FR-019–FR-027)", () => {
  it("builds the prompt from voice, brand, posting instructions and the comment; records voice + version; spends under engagement.reply", async () => {
    const env = await postsEnv();
    await setBrand(env.scope);
    const scope = await env.as(env.owner);
    const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Warm and plain." } });
    const account = await env.account({});
    await scope.accounts.setPostingInstructions(account.id, "Always thank the commenter.");
    const itemId = await seedItem(scope, account.id, "Love this bakery!");

    const llm = createFakeLlm([{ ok: { text: "Thanks so much for the kind words!" } }]);
    setLlmForTests(llm);

    const result = await requestDraft(scope, itemId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.text).toBe("Thanks so much for the kind words!");
    expect(result.countingRule).toBe("graphemes");

    const draft = await scope.engagementDrafts.get(result.draftId);
    expect(draft).toMatchObject({ origin: "model", voiceProfileId: profile.id, voiceProfileVersion: 1, reviewState: "needs_review" });

    const req = llm.requests[0]!;
    expect(req.user).toContain("Love this bakery!");
    expect(req.system).toContain("Warm and plain.");
    expect(req.system).toContain("Fresh bread daily");

    const usage = await scope.llmUsage.byPurpose({ from: new Date("2020-01-01"), to: new Date("2030-01-01") });
    expect(usage.find((u) => u.purpose === "engagement.reply")?.calls).toBe(1);
  });

  it("an over-long draft is stored in full, never truncated", async () => {
    const env = await postsEnv();
    const scope = await env.as(env.owner);
    await createVoiceProfile(env.project.id, {});
    const account = await env.account({});
    const itemId = await seedItem(scope, account.id);
    const longText = "a".repeat(600);
    setLlmForTests(createFakeLlm([{ ok: { text: longText } }]));

    const result = await requestDraft(scope, itemId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.text).toBe(longText);
    expect(result.count).toBeGreaterThan(result.limit);
    const draft = await scope.engagementDrafts.get(result.draftId);
    expect(draft?.text).toBe(longText);
  });

  it("refuses no_voice when the project has no voice profile", async () => {
    const env = await postsEnv();
    const scope = await env.as(env.owner);
    const account = await env.account({});
    const itemId = await seedItem(scope, account.id);
    setLlmForTests(createFakeLlm([{ ok: { text: "ignored" } }]));
    const result = await requestDraft(scope, itemId);
    expect(result).toMatchObject({ ok: false, code: "no_voice" });
  });

  it("refuses no_text when the item has no text", async () => {
    const env = await postsEnv();
    const scope = await env.as(env.owner);
    await createVoiceProfile(env.project.id, {});
    const account = await env.account({});
    const itemId = await seedItem(scope, account.id, "");
    setLlmForTests(createFakeLlm([{ ok: { text: "ignored" } }]));
    const result = await requestDraft(scope, itemId);
    expect(result).toMatchObject({ ok: false, code: "no_text" });
  });

  it("refuses credit_hold with no partial draft stored", async () => {
    const env = await postsEnv();
    const scope = await env.as(env.owner);
    await createVoiceProfile(env.project.id, {});
    const account = await env.account({});
    const itemId = await seedItem(scope, account.id);
    setLlmForTests(createFakeLlm([{ fail: "credit_exhausted" }]));
    const result = await requestDraft(scope, itemId);
    expect(result).toMatchObject({ ok: false, code: "credit_hold" });
    const drafts = await scope.engagementDrafts.listByItem(itemId);
    expect(drafts).toHaveLength(0);
  });

  it("a scope without engagement:reply is refused on the server (FR-036)", async () => {
    const env = await postsEnv();
    await createVoiceProfile(env.project.id, {});
    const account = await env.account({});
    const ownerScope = await env.as(env.owner);
    const itemId = await seedItem(ownerScope, account.id);
    const viewOnlyScope = { ...ownerScope, can: (req: Parameters<typeof ownerScope.can>[0]) => ("engagement" in req ? false : ownerScope.can(req)) };
    await expect(requestDraft(viewOnlyScope as typeof ownerScope, itemId)).rejects.toThrow();
  });
});

describe("writeReply and editDraft (FR-026, FR-011)", () => {
  it("a person writes a reply with no model call", async () => {
    const env = await postsEnv();
    const scope = await env.as(env.owner);
    const account = await env.account({});
    const itemId = await seedItem(scope, account.id);
    const result = await writeReply(scope, itemId, "Thanks for stopping by!");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const draft = await scope.engagementDrafts.get(result.draftId);
    expect(draft).toMatchObject({ origin: "person", text: "Thanks for stopping by!" });
  });

  it("editing a draft stamps acknowledged_edit_at and refuses empty text", async () => {
    const env = await postsEnv();
    const scope = await env.as(env.owner);
    const account = await env.account({});
    const itemId = await seedItem(scope, account.id);
    const written = await writeReply(scope, itemId, "Hello!");
    if (!written.ok) throw new Error("unreachable");
    const edited = await editDraft(scope, written.draftId, "Hello there!");
    expect(edited.ok).toBe(true);
    const draft = await scope.engagementDrafts.get(written.draftId);
    expect(draft?.text).toBe("Hello there!");
    expect(draft?.acknowledgedEditAt).not.toBeNull();

    const empty = await editDraft(scope, written.draftId, "   ");
    expect(empty).toMatchObject({ ok: false, code: "no_text" });
  });
});
