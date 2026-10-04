import { afterAll, describe, expect, it } from "vitest";
import * as posts from "../../../src/server/services/posts";
import * as queue from "../../../src/server/services/queue";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const NOW = new Date("2026-10-01T12:00:00Z");

type Env = Awaited<ReturnType<typeof postsEnv>>;
/** Three queued posts on Mondays 1, 2 and 3; the first is cancelled, leaving a gap at the front. */
async function gapped(env: Env) {
  const a = await env.account();
  const ids: { postId: string; targetId: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const p = await posts.createDraft(env.scope, { baseText: `post ${i}`, targets: [{ accountId: a.id }] });
    await atTime(NOW, () => posts.addToQueue(env.scope, p.post.id));
    ids.push({ postId: p.post.id, targetId: p.targets[0]!.id });
  }
  await atTime(NOW, () => posts.cancelTarget(env.scope, ids[0]!.targetId));
  return { a, ids };
}
const times = async (env: Env, ids: { targetId: string }[]) =>
  Promise.all(ids.map(async (i) => (await env.scope.targets.get(i.targetId))!.slotOccurrenceAt?.toISOString() ?? null));

describe("previewPullQueueForward", () => {
  it("lists the moves and leaves nothing changed", async () => {
    const env = await postsEnv();
    const { a, ids } = await gapped(env);
    const before = await times(env, ids);
    const preview = await atTime(NOW, () => queue.previewPullQueueForward(env.scope, a.id));
    expect(preview.moved.map((m) => m.targetId)).toEqual([ids[1]!.targetId, ids[2]!.targetId]);
    expect(preview.moved[0]).toMatchObject({ from: before[1], to: before[1] && new Date(Date.parse(before[1]) - 7 * 86_400_000).toISOString() });
    expect(preview.moved[0]!.fromLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2} /);
    expect(await times(env, ids)).toEqual(before);
  });

  it("matches what pullQueueForward then does", async () => {
    const env = await postsEnv();
    const { a, ids } = await gapped(env);
    const preview = await atTime(NOW, () => queue.previewPullQueueForward(env.scope, a.id));
    const pulled = await atTime(NOW, () => queue.pullQueueForward(env.scope, a.id));
    expect(pulled.moved).toEqual(preview.moved);
    const after = await times(env, ids);
    expect(after[1]).toBe(preview.moved[0]!.to);
    expect(after[2]).toBe(preview.moved[1]!.to);
  });

  it("marks entries that differ from the previewed moves", async () => {
    const env = await postsEnv();
    const { a, ids } = await gapped(env);
    const preview = await atTime(NOW, () => queue.previewPullQueueForward(env.scope, a.id));
    const expected = preview.moved.map((m) => ({ targetId: m.targetId, to: m.to }));
    expected[1] = { ...expected[1]!, to: "2030-01-01T00:00:00.000Z" };
    const pulled = await atTime(NOW, () => queue.pullQueueForward(env.scope, a.id, { expected }));
    expect(pulled.moved.map((m) => m.differsFromPreview)).toEqual([false, true]);
    expect(ids).toHaveLength(3);
  });
});

describe("listQueuedForAccount", () => {
  it("lists future queued targets of the account with excerpt and local time", async () => {
    const env = await postsEnv();
    const { a, ids } = await gapped(env);
    const other = await env.account();
    const p = await posts.createDraft(env.scope, { baseText: "elsewhere", targets: [{ accountId: other.id }] });
    await atTime(NOW, () => posts.addToQueue(env.scope, p.post.id));
    const list = await atTime(NOW, () => queue.listQueuedForAccount(env.scope, a.id));
    expect(list.map((i) => i.targetId)).toEqual([ids[1]!.targetId, ids[2]!.targetId]);
    expect(list[0]).toMatchObject({ excerpt: "post 1" });
    expect(list[0]!.localTime).toMatch(/^\d{4}-\d{2}-\d{2}T09:00 /);
  });
});
