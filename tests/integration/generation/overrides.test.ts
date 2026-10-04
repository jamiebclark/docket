import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { failFromError } from "../../../src/lib/action-result";
import { PolicyNotAllowedError } from "../../../src/server/dal/errors";
import * as projectsService from "../../../src/server/services/projects";
import { generateSingle } from "../../../src/server/services/generation/single";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { createVoiceProfile } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const ok = (text: string) => ({ ok: { variants: { mock: { text } } } });

async function setup() {
  const env = await postsEnv();
  const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Plain." } });
  const account = await env.account();
  const input = (over: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    voiceProfileId: profile.id,
    brief: "Overrides",
    targetAccountIds: [account.id],
    ...over,
  });
  async function setDefaults(defaultApprovalPolicy: string, defaultSchedulingPolicy: string) {
    await projectsService.updateSettings(env.scope, {
      name: "P",
      slug: env.project.slug,
      timezone: "UTC",
      defaultApprovalPolicy,
      defaultSchedulingPolicy,
      confirmUnreviewedQueue: true,
    });
  }
  return { env, input, setDefaults };
}

describe("policy overrides by role", () => {
  it("refuses an editor's auto-approve before any model call or row is written", async () => {
    const t = await setup();
    const llm = createFakeLlm([ok("never")]);
    const editor = await t.env.as(t.env.editor);
    const err = await generateSingle(editor, t.input({ approval: "auto_approve" }), llm).catch((e) => e);
    expect(err).toBeInstanceOf(PolicyNotAllowedError);
    expect(err.message).toBe("Only owners and admins can auto-approve");
    expect(failFromError(err)).toMatchObject({ ok: false, error: "forbidden", message: "Only owners and admins can auto-approve" });
    expect(llm.requests).toHaveLength(0);
    expect(await t.env.scope.generationFailures.listRecent(5)).toHaveLength(0);
  });

  it("applies an editor's project default of auto_approve without an override", async () => {
    const t = await setup();
    await t.setDefaults("auto_approve", "leave_as_draft");
    const editor = await t.env.as(t.env.editor);
    const res = await generateSingle(editor, t.input(), createFakeLlm([ok("Hello")]));
    expect(res).toMatchObject({ ok: true, decision: { reviewState: "approved" } });
  });

  it("lets an editor choose either scheduling policy", async () => {
    const t = await setup();
    const editor = await t.env.as(t.env.editor);
    for (const scheduling of ["leave_as_draft", "add_to_queue"]) {
      const res = await generateSingle(editor, t.input({ scheduling }), createFakeLlm([ok("Hi")]));
      expect(res.ok).toBe(true);
    }
  });

  it("requires confirmUnreviewedQueue for auto + queue", async () => {
    const t = await setup();
    const llm = createFakeLlm([ok("Hi")]);
    const over = { approval: "auto_approve", scheduling: "add_to_queue" };
    const err = await generateSingle(t.env.scope, t.input(over), llm).catch((e) => e);
    expect(err.name).toBe("ZodError");
    expect(err.issues[0]).toMatchObject({ path: ["confirmUnreviewedQueue"] });
    expect(llm.requests).toHaveLength(0);
    const res = await generateSingle(t.env.scope, t.input({ ...over, confirmUnreviewedQueue: true }), llm);
    expect(res).toMatchObject({ ok: true, decision: { reviewState: "approved", queue: true } });
  });

  it.each(["owner", "admin"] as const)("applies the %s's override to the request only", async (who) => {
    const t = await setup();
    const scope = await t.env.as(t.env[who]);
    const res = await generateSingle(scope, t.input({ approval: "auto_approve" }), createFakeLlm([ok("Hi")]));
    expect(res).toMatchObject({ ok: true, decision: { reviewState: "approved" } });
    const fresh = await t.env.as(t.env[who]);
    expect(fresh.project.defaultApprovalPolicy).toBe("review_required");
    expect(fresh.project.defaultSchedulingPolicy).toBe("leave_as_draft");
  });
});
