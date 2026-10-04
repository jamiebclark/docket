/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, describe, expect, it } from "vitest";
import { NotFoundError, PolicyNotAllowedError } from "../../../src/server/dal/errors";
import { getSeries, planSeries, startSeries, writeSeriesPost } from "../../../src/server/services/generation/series";
import { closeDb } from "../../helpers/db";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { createVoiceProfile } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const angles = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ title: `Angle ${i + 1}`, description: `About thing ${i + 1}` }));
const plan = (n: number): FakeStep => ({ ok: { angles: angles(n) } });
const post = (text: string): FakeStep => ({ ok: { variants: { mock: { text } } } });

async function setup() {
  const env = await postsEnv();
  const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Plain." } });
  const account = await env.account();
  const input = (over: Record<string, unknown> = {}) => ({
    voiceProfileId: profile.id,
    brief: "Launch week",
    targetAccountIds: [account.id],
    count: 5,
    ...over,
  });
  const start = async (n = 4, over: Record<string, unknown> = {}) =>
    (await startSeries(env.scope, input({ angles: angles(n), ...over }))).seriesId;
  return { env, profile, account, input, start };
}

describe("planSeries", () => {
  it("returns the angles and saves no post and no series", async () => {
    const t = await setup();
    const llm = createFakeLlm([plan(5)]);
    const res = await planSeries(t.env.scope, t.input(), llm);
    expect(res).toMatchObject({ ok: true, angles: angles(5) });
    expect(llm.requests[0]!.label).toBe("generate.series_plan");
    expect((await t.env.scope.posts.list({ limit: 10, offset: 0 })).total).toBe(0);
  });

  it("records a failure row and nothing else when the plan is unreadable twice", async () => {
    const t = await setup();
    const res = await planSeries(t.env.scope, t.input(), createFakeLlm([{ raw: "nope" }, { raw: "still nope" }]));
    expect(res).toMatchObject({ ok: false, kind: "invalid_output" });
    const [failure] = await t.env.scope.generationFailures.listRecent(5);
    expect(failure).toMatchObject({ mode: "series_plan", seriesId: null });
    expect((await t.env.scope.posts.list({ limit: 10, offset: 0 })).total).toBe(0);
  });

  it("retries once, naming the count, when the angle count is wrong", async () => {
    const t = await setup();
    const llm = createFakeLlm([plan(4), plan(5)]);
    const res = await planSeries(t.env.scope, t.input(), llm);
    expect(res.ok).toBe(true);
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.user).toContain("Expected 5 angles, got 4.");
  });

  it("fails after the retry when the count is still wrong", async () => {
    const t = await setup();
    const res = await planSeries(t.env.scope, t.input(), createFakeLlm([plan(4), plan(3)]));
    expect(res).toMatchObject({ ok: false, kind: "invalid_output" });
  });
});

describe("startSeries", () => {
  it("saves the series with the resolved policies and makes no model call", async () => {
    const t = await setup();
    const id = await t.start(4);
    const series = (await t.env.scope.series.get(id))!;
    expect(series.plannedCount).toBe(5);
    expect((series.plan as any).angles).toHaveLength(4);
    expect((series.request as any).resolved).toEqual({ approval: "review_required", scheduling: "leave_as_draft" });
  });

  it("validates 1 to 10 angles", async () => {
    const t = await setup();
    await expect(startSeries(t.env.scope, t.input({ angles: [] }))).rejects.toThrow();
    await expect(startSeries(t.env.scope, t.input({ angles: angles(11) }))).rejects.toThrow();
    await expect(t.start(1)).resolves.toBeTruthy();
  });

  it("refuses an editor's auto-approve and an unconfirmed auto-approve with queue", async () => {
    const t = await setup();
    const editor = await t.env.as(t.env.editor);
    await expect(startSeries(editor, t.input({ angles: angles(2), approval: "auto_approve" }))).rejects.toBeInstanceOf(
      PolicyNotAllowedError,
    );
    await expect(
      startSeries(t.env.scope, t.input({ angles: angles(2), approval: "auto_approve", scheduling: "add_to_queue" })),
    ).rejects.toThrow(/confirm|unreviewed/i);
  });
});

describe("writeSeriesPost", () => {
  it("writes the angles in order, each prompt naming its angle and the other titles", async () => {
    const t = await setup();
    const id = await t.start(4);
    const llm = createFakeLlm([post("p0"), post("p1"), post("p2"), post("p3")]);
    for (let i = 0; i < 4; i++) {
      const res = await writeSeriesPost(t.env.scope, id, i, llm);
      expect(res).toMatchObject({ ok: true, existing: false, position: i });
    }
    for (const [i, req] of llm.requests.entries()) {
      expect(req.user).toContain(`Angle ${i + 1}`);
      expect(req.user).toContain(`About thing ${i + 1}`);
      const others = req.user.split("OTHER POSTS IN THE SERIES")[1]!;
      expect(others).not.toContain(`- Angle ${i + 1}\n`);
      for (let j = 0; j < 4; j++) if (j !== i) expect(others).toContain(`- Angle ${j + 1}`);
    }
    // SC-009: no two prompts share an angle.
    expect(new Set(llm.requests.map((r) => r.user.match(/Angle \d/)?.[0])).size).toBe(4);
    for (let i = 0; i < 4; i++) {
      const p = (await t.env.scope.posts.findBySeriesPosition(id, i))!;
      expect(p).toMatchObject({ seriesId: id, seriesPosition: i, baseText: `p${i}` });
      expect((p.generationMetadata as any).records[0].mode).toBe("series_post");
    }
  });

  it("returns the existing post for a written position and creates no duplicate", async () => {
    const t = await setup();
    const id = await t.start(2);
    const llm = createFakeLlm([post("only")]);
    const first = await writeSeriesPost(t.env.scope, id, 0, llm);
    const again = await writeSeriesPost(t.env.scope, id, 0, llm);
    expect(again).toMatchObject({ ok: true, existing: true, position: 0 });
    expect(again.ok && first.ok && again.postId === first.postId).toBe(true);
    expect(llm.requests).toHaveLength(1);
  });

  it("keeps the others when one angle fails, and a retry leaves exactly one post there", async () => {
    const t = await setup();
    const id = await t.start(3);
    const llm = createFakeLlm([post("a"), { fail: "unavailable" }, post("c"), post("b")]);
    await writeSeriesPost(t.env.scope, id, 0, llm);
    const failed = await writeSeriesPost(t.env.scope, id, 1, llm);
    expect(failed).toMatchObject({ ok: false, kind: "unavailable", position: 1 });
    await writeSeriesPost(t.env.scope, id, 2, llm);
    let state = await getSeries(t.env.scope, id);
    expect(state.posts.map((p) => p?.baseText ?? null)).toEqual(["a", null, "c"]);
    expect(state.failures[1]).toMatchObject({ kind: "unavailable" });
    const [row] = await t.env.scope.generationFailures.listForSeries(id);
    expect(row).toMatchObject({ mode: "series_post", seriesId: id, seriesPosition: 1 });

    expect(await writeSeriesPost(t.env.scope, id, 1, llm)).toMatchObject({ ok: true, existing: false });
    state = await getSeries(t.env.scope, id);
    expect(state.posts.map((p) => p?.baseText)).toEqual(["a", "b", "c"]);
    expect(state.failures).toEqual([null, null, null]);
  });

  it("leaves one post under two concurrent calls", async () => {
    const t = await setup();
    const id = await t.start(2);
    const results = await Promise.all([
      writeSeriesPost(t.env.scope, id, 0, createFakeLlm([post("x")])),
      writeSeriesPost(t.env.scope, id, 0, createFakeLlm([post("y")])),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const ids = new Set(results.map((r) => (r.ok ? r.postId : "")));
    expect(ids.size).toBe(1);
  });

  it("queues auto-approved posts into successive free slots in plan order", async () => {
    const t = await setup();
    const id = await t.start(2, { approval: "auto_approve", scheduling: "add_to_queue", confirmUnreviewedQueue: true });
    const llm = createFakeLlm([post("first"), post("second")]);
    const a = await writeSeriesPost(t.env.scope, id, 0, llm);
    const b = await writeSeriesPost(t.env.scope, id, 1, llm);
    if (!a.ok || !b.ok) throw new Error("generation failed");
    const [ta] = await t.env.scope.targets.listForPost(a.postId);
    const [tb] = await t.env.scope.targets.listForPost(b.postId);
    expect(ta!.status).toBe("scheduled");
    expect(tb!.scheduledAt!.getTime()).toBeGreaterThan(ta!.scheduledAt!.getTime());
  });

  it("does not find another project's series", async () => {
    const t = await setup();
    const other = await setup();
    const id = await other.start(2);
    await expect(writeSeriesPost(t.env.scope, id, 0, createFakeLlm([]))).rejects.toBeInstanceOf(NotFoundError);
    await expect(getSeries(t.env.scope, id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
