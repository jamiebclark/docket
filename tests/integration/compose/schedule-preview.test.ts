import { afterAll, describe, expect, it } from "vitest";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const NOW = new Date("2026-03-01T12:00:00Z");

async function setup(timezone: string) {
  const env = await postsEnv();
  // Same scope, but the project reads as being in `timezone`.
  const scope = Object.create(env.scope, { project: { value: { ...env.scope.project, timezone } } }) as typeof env.scope;
  return { env, scope };
}

describe("previewExplicitTime", () => {
  it("reports an ordinary time as exact", async () => {
    const t = await setup("America/New_York");
    const p = await atTime(NOW, () => posts.previewExplicitTime(t.scope, { local: "2026-03-10T09:30" }));
    expect(p).toMatchObject({ kind: "exact", instant: "2026-03-10T13:30:00.000Z", resolvedLocal: "2026-03-10T09:30", inPast: false });
  });

  it("reports a spring-forward gap and the time it will post", async () => {
    const t = await setup("America/New_York");
    const p = await atTime(NOW, () => posts.previewExplicitTime(t.scope, { local: "2026-03-08T02:30" }));
    expect(p).toMatchObject({ kind: "gap", instant: "2026-03-08T07:30:00.000Z", resolvedLocal: "2026-03-08T03:30" });
  });

  it("reports a fall-back overlap, taking the earlier instant", async () => {
    const t = await setup("America/New_York");
    const p = await atTime(NOW, () => posts.previewExplicitTime(t.scope, { local: "2026-11-01T01:30" }));
    expect(p).toMatchObject({ kind: "overlap", instant: "2026-11-01T05:30:00.000Z", resolvedLocal: "2026-11-01T01:30" });
  });

  it("flags a past time without throwing", async () => {
    const t = await setup("UTC");
    const p = await atTime(NOW, () => posts.previewExplicitTime(t.scope, { local: "2026-02-01T09:00" }));
    expect(p.inPast).toBe(true);
  });

  it("warns, without blocking, when another post is queued near that time on an account", async () => {
    const t = await setup("UTC");
    const account = await t.env.account({}, false);
    const draft = await posts.createDraft(t.env.scope, { baseText: "queued", mediaIds: [], targets: [{ accountId: account.id }] });
    await atTime(NOW, () => posts.scheduleAt(t.env.scope, draft.post.id, { at: "2026-03-10T09:00:00.000Z" }));
    const near = await atTime(NOW, () =>
      posts.previewExplicitTime(t.scope, { local: "2026-03-10T09:05", accountIds: [account.id] }),
    );
    expect(near.warnings.map((w) => w.code)).toEqual(["near_queued_target"]);
    expect(near.inPast).toBe(false);
    const far = await atTime(NOW, () =>
      posts.previewExplicitTime(t.scope, { local: "2026-03-12T09:05", accountIds: [account.id] }),
    );
    expect(far.warnings).toEqual([]);
  });
});
