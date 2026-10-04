/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as accounts from "../../../src/server/services/accounts";
import { decidePolicy } from "../../../src/server/services/generation/policy";
import { generateSingle } from "../../../src/server/services/generation/single";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { createVoiceProfile } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const ok = (variants: Record<string, string>) => ({
  ok: { variants: Object.fromEntries(Object.entries(variants).map(([k, text]) => [k, { text }])) },
});
const TOO_LONG = "x".repeat(600);

async function setup() {
  const env = await postsEnv();
  const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Plain." } });
  const input = (targetAccountIds: string[], over: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    voiceProfileId: profile.id,
    brief: "Policy matrix",
    targetAccountIds,
    ...over,
  });
  return { env, input };
}

const APPROVALS = ["review_required", "auto_approve"] as const;
const SCHEDULINGS = ["leave_as_draft", "add_to_queue"] as const;

describe("approval × scheduling × validation matrix", () => {
  for (const approval of APPROVALS) {
    for (const scheduling of SCHEDULINGS) {
      for (const valid of [true, false]) {
        it(`${approval} + ${scheduling} + ${valid ? "valid" : "invalid after retry"}`, async () => {
          const t = await setup();
          const account = await t.env.account();
          const llm = createFakeLlm(valid ? [ok({ mock: "Fine" })] : [ok({ mock: TOO_LONG }), ok({ mock: TOO_LONG })]);
          const res = await generateSingle(
            t.env.scope,
            t.input([account.id], { approval, scheduling, confirmUnreviewedQueue: true }),
            llm,
          );
          expect(res.ok).toBe(true);
          if (!res.ok) return;
          const expected = decidePolicy({
            approval,
            scheduling,
            blocking: valid ? [] : [{ providerKey: "mock", message: "too long" }],
          });
          const post = (await t.env.scope.posts.get(res.postId))!;
          const targets = await t.env.scope.targets.listForPost(res.postId);
          expect(post.reviewState).toBe(expected.reviewState);
          expect(res.decision.reviewState).toBe(expected.reviewState);
          expect(res.decision.queue).toBe(expected.queue);
          const record = (post.generationMetadata as any).records[0];
          expect(record.policies.decision).toMatchObject({ reviewState: expected.reviewState, queued: expected.queue });
          if (expected.queue) {
            expect(targets.map((x) => x.status)).toEqual(["scheduled"]);
            expect(targets[0]!.scheduledAt).not.toBeNull();
          } else {
            expect(targets.every((x) => x.status === "draft")).toBe(true);
          }
          if (!valid) {
            // SC-003: an invalid post never ends approved or scheduled.
            expect(post.reviewState).toBe("needs_review");
            expect(targets.some((x) => x.status === "scheduled")).toBe(false);
            expect(res.decision.reason).toMatch(/^Forced to review: /);
          }
        });
      }
    }
  }

  it("puts queued targets in their next free slots", async () => {
    const t = await setup();
    const account = await t.env.account();
    const a = await generateSingle(
      t.env.scope,
      t.input([account.id], { approval: "auto_approve", scheduling: "add_to_queue", confirmUnreviewedQueue: true }),
      createFakeLlm([ok({ mock: "First" })]),
    );
    const b = await generateSingle(
      t.env.scope,
      t.input([account.id], { approval: "auto_approve", scheduling: "add_to_queue", confirmUnreviewedQueue: true }),
      createFakeLlm([ok({ mock: "Second" })]),
    );
    if (!a.ok || !b.ok) throw new Error("generation failed");
    const [ta] = await t.env.scope.targets.listForPost(a.postId);
    const [tb] = await t.env.scope.targets.listForPost(b.postId);
    expect(ta!.status).toBe("scheduled");
    expect(tb!.status).toBe("scheduled");
    expect(tb!.scheduledAt!.getTime()).toBeGreaterThan(ta!.scheduledAt!.getTime());
  });

  it("forces review for an Instagram target without media, whatever the policy", async () => {
    const t = await setup();
    const ig = await accounts.saveConnectedAccount(t.env.scope, {
      providerKey: "instagram",
      externalAccountId: `ig-${randomUUID().slice(0, 8)}`,
      displayName: "Insta",
      settings: {},
    });
    const res = await generateSingle(
      t.env.scope,
      t.input([ig.id], { approval: "auto_approve", scheduling: "leave_as_draft" }),
      createFakeLlm([ok({ instagram: "Caption only" }), ok({ instagram: "Caption only" })]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.decision.reviewState).toBe("needs_review");
    expect(res.decision.reason).toMatch(/^Forced to review: /);
    expect((await t.env.scope.posts.get(res.postId))!.reviewState).toBe("needs_review");
  });
});
