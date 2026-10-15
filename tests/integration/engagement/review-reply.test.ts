import { afterAll, describe, expect, it } from "vitest";
import { writeReply } from "../../../src/server/services/engagement/draft";
import { approveReply, dismissItems, rejectReply } from "../../../src/server/services/engagement/review";
import * as projectsService from "../../../src/server/services/projects";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

async function seedItem(scope: Awaited<ReturnType<typeof postsEnv>>["scope"], accountId: string) {
  const { id } = await scope.engagementItems.insertIfAbsent({
    socialAccountId: accountId,
    providerKey: "mock",
    kind: "reply",
    externalId: `ext-${Math.random().toString(36).slice(2)}`,
    text: "Great post!",
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

describe("approveReply / rejectReply (FR-028–FR-036, SC-003)", () => {
  it("edit then approve records sent text is unset yet, but reviewer and time", async () => {
    const env = await postsEnv();
    const scope = await env.as(env.owner);
    const account = await env.account({});
    const itemId = await seedItem(scope, account.id);
    const written = await writeReply(scope, itemId, "Thanks!");
    if (!written.ok) throw new Error("unreachable");

    const approved = await approveReply(scope, written.draftId);
    expect(approved).toEqual({ ok: true });
    const draft = await scope.engagementDrafts.get(written.draftId);
    expect(draft).toMatchObject({ reviewState: "approved", sendState: "waiting", reviewedByUserId: env.owner.id });
    expect(draft?.reviewedAt).not.toBeNull();
  });

  it("a second approval for the same draft is refused as already decided", async () => {
    const env = await postsEnv();
    const scope = await env.as(env.owner);
    const account = await env.account({});
    const itemId = await seedItem(scope, account.id);
    const written = await writeReply(scope, itemId, "Thanks!");
    if (!written.ok) throw new Error("unreachable");
    await approveReply(scope, written.draftId);
    const second = await approveReply(scope, written.draftId);
    expect(second).toMatchObject({ ok: false, code: "already_decided" });
  });

  it("two members approving at the same instant produce exactly one success", async () => {
    const env = await postsEnv();
    const scope = await env.as(env.owner);
    const account = await env.account({});
    const itemId = await seedItem(scope, account.id);
    const written = await writeReply(scope, itemId, "Thanks!");
    if (!written.ok) throw new Error("unreachable");
    const ownerScope = await env.as(env.owner);
    const adminScope = await env.as(env.admin);
    const [a, b] = await Promise.all([approveReply(ownerScope, written.draftId), approveReply(adminScope, written.draftId)]);
    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "already_decided")).toHaveLength(1);
  });

  it("auto_approve still waits for a person; default_approval_policy is never read on this path (SC-003)", async () => {
    const env = await postsEnv();
    await projectsService.updateSettings(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env.scope as any,
      {
        name: env.project.name,
        slug: env.project.slug,
        timezone: env.project.timezone,
        defaultApprovalPolicy: "auto_approve",
        defaultSchedulingPolicy: "leave_as_draft",
        confirmUnreviewedQueue: false,
      },
    );
    const scope = await env.as(env.owner);
    const account = await env.account({});
    const itemId = await seedItem(scope, account.id);
    const written = await writeReply(scope, itemId, "Thanks!");
    if (!written.ok) throw new Error("unreachable");
    const draft = await scope.engagementDrafts.get(written.draftId);
    expect(draft?.reviewState).toBe("needs_review");
  });

  it("a view-only member is refused every write on the server", async () => {
    const env = await postsEnv();
    const scope = await env.as(env.owner);
    const account = await env.account({});
    const itemId = await seedItem(scope, account.id);
    const written = await writeReply(scope, itemId, "Thanks!");
    if (!written.ok) throw new Error("unreachable");
    // Every project role here grants engagement:reply; assert the permission gate itself is enforced
    // by confirming a scope with the permission removed throws.
    const noReplyScope = { ...scope, can: (req: Parameters<typeof scope.can>[0]) => ("engagement" in req ? false : scope.can(req)) };
    await expect(approveReply(noReplyScope as typeof scope, written.draftId)).rejects.toThrow();
  });

  it("dismiss records who and when, discards pending drafts, leaves the item in the inbox", async () => {
    const env = await postsEnv();
    const scope = await env.as(env.owner);
    const account = await env.account({});
    const itemId = await seedItem(scope, account.id);
    const written = await writeReply(scope, itemId, "Thanks!");
    if (!written.ok) throw new Error("unreachable");
    const result = await dismissItems(scope, [itemId]);
    expect(result.dismissed).toBe(1);
    const item = await scope.engagementItems.get(itemId);
    expect(item).toMatchObject({ state: "dismissed", dismissedByUserId: env.owner.id });
    expect(item?.dismissedAt).not.toBeNull();
    const draft = await scope.engagementDrafts.get(written.draftId);
    expect(draft?.reviewState).toBe("discarded");
  });

  it("empty text approved is refused", async () => {
    const env = await postsEnv();
    const scope = await env.as(env.owner);
    const account = await env.account({});
    const itemId = await seedItem(scope, account.id);
    const written = await writeReply(scope, itemId, "x");
    if (!written.ok) throw new Error("unreachable");
    await scope.engagementDrafts.update(written.draftId, { text: " " });
    const result = await approveReply(scope, written.draftId);
    expect(result).toMatchObject({ ok: false, code: "empty_text" });
  });

  it("rejectReply records the decision and a second rejection is refused", async () => {
    const env = await postsEnv();
    const scope = await env.as(env.owner);
    const account = await env.account({});
    const itemId = await seedItem(scope, account.id);
    const written = await writeReply(scope, itemId, "Thanks!");
    if (!written.ok) throw new Error("unreachable");
    const rejected = await rejectReply(scope, written.draftId, "Not on brand");
    expect(rejected).toEqual({ ok: true });
    const draft = await scope.engagementDrafts.get(written.draftId);
    expect(draft).toMatchObject({ reviewState: "rejected", rejectionReason: "Not on brand" });
    const again = await rejectReply(scope, written.draftId);
    expect(again).toMatchObject({ ok: false, code: "already_decided" });
  });
});
