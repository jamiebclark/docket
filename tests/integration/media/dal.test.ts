import { afterAll, describe, expect, it } from "vitest";
import { createSchedulingRepos } from "../../../src/server/dal/scope";
import { closeDb, testDb } from "../../helpers/db";
import { createProject } from "../../helpers/factories";
import { createDraftPost, createMediaAsset, createMockAccount } from "../../helpers/scheduling";

afterAll(async () => {
  await closeDb();
});

// Every query below runs through the scope recorder (tests/setup), so an unpinned query or a join
// without the project_id equality fails the test that issued it. These exercise the 003 additions.
async function setup() {
  const project = await createProject();
  const repos = createSchedulingRepos(testDb(), project.id);
  return { project, repos };
}

describe("media DAL additions", () => {
  it("lists, filters, tags, updates and soft-deletes", async () => {
    const { project, repos } = await setup();
    const a = await createMediaAsset(project.id, { altText: "A red barn" });
    const b = await createMediaAsset(project.id);
    await repos.media.update(a.id, { tags: ["farm", "red"] });

    expect((await repos.media.list({ limit: 24, offset: 0 })).total).toBe(2);
    expect((await repos.media.list({ tag: "farm", limit: 24, offset: 0 })).rows.map((r) => r.id)).toEqual([a.id]);
    expect((await repos.media.list({ missingAlt: true, limit: 24, offset: 0 })).rows.map((r) => r.id)).toEqual([b.id]);
    expect((await repos.media.list({ q: "BARN", limit: 24, offset: 0 })).rows.map((r) => r.id)).toEqual([a.id]);
    expect((await repos.media.list({ q: "%", limit: 24, offset: 0 })).total).toBe(0);
    expect(await repos.media.listTags()).toEqual(["farm", "red"]);

    await repos.media.markUsed([a.id], new Date());
    expect((await repos.media.list({ unused: true, limit: 24, offset: 0 })).rows.map((r) => r.id)).toEqual([b.id]);

    await repos.media.lockForUpdate(a.id);
    await repos.media.softDelete(a.id, new Date());
    expect(await repos.media.get(a.id)).toBeNull();
    expect((await repos.media.getIncludingDeleted(a.id))?.deletedAt).not.toBeNull();
    expect(await repos.media.lockShared([a.id, b.id])).toHaveLength(1);
    expect(await repos.media.listTags()).toEqual([]);
  });

  it("stores variants once per constraints hash and removes them", async () => {
    const { project, repos } = await setup();
    const a = await createMediaAsset(project.id);
    const row = {
      mediaAssetId: a.id,
      constraintsHash: "h".repeat(32),
      storageKey: `projects/${project.id}/media/${a.id}/v/h.jpg`,
      publicUrl: "http://localhost/v.jpg",
      mimeType: "image/jpeg",
      width: 10,
      height: 10,
      byteSize: 100,
      steps: ["convert"],
    };
    const first = await repos.media.insertVariant(row);
    const again = await repos.media.insertVariant(row);
    expect(again.id).toBe(first.id);
    expect((await repos.media.getVariant(a.id, row.constraintsHash))?.id).toBe(first.id);
    expect(await repos.media.listVariants(a.id)).toHaveLength(1);
    expect(await repos.media.deleteVariants(a.id)).toHaveLength(1);
    expect(await repos.media.getVariant(a.id, row.constraintsHash)).toBeNull();
  });

  it("reports and detaches the posts using an asset, renumbering positions", async () => {
    const { project, repos } = await setup();
    const account = await createMockAccount(project.id);
    const [m1, m2, m3] = [
      await createMediaAsset(project.id),
      await createMediaAsset(project.id),
      await createMediaAsset(project.id),
    ];
    const { post } = await createDraftPost(project.id, { accountIds: [account.id], mediaIds: [m1!.id, m2!.id, m3!.id] });
    expect(await repos.media.postsUsing(m1!.id)).toEqual([{ postId: post.id, targetStatuses: ["draft"] }]);
    await repos.media.detachFromPosts(m1!.id, [post.id]);
    expect(await repos.posts.listMediaIds(post.id)).toEqual([m2!.id, m3!.id]);
  });
});

describe("posts, targets and accounts DAL additions", () => {
  it("lists posts with counts, targets in a range, and account impact", async () => {
    const { project, repos } = await setup();
    const account = await createMockAccount(project.id);
    const { post, targets } = await createDraftPost(project.id, { accountIds: [account.id] });
    const when = new Date("2030-01-01T12:00:00Z");
    await repos.targets.update(targets[0]!.id, {
      status: "scheduled",
      scheduledAt: when,
      nextAttemptAt: when,
      scheduleKind: "explicit",
    });
    await repos.posts.setStatus(post.id, "scheduled");

    const list = await repos.posts.list({ status: "scheduled", limit: 20, offset: 0 });
    expect(list.total).toBe(1);
    expect(list.rows[0]?.relevantAt?.toISOString()).toBe(when.toISOString());
    expect(list.rows[0]?.targets).toHaveLength(1);
    expect((await repos.posts.list({ needsDecision: true, limit: 20, offset: 0 })).total).toBe(0);
    const counts = await repos.posts.counts();
    expect(counts.scheduled).toBe(1);
    expect(counts.needs_decision).toBe(0);

    const inRange = await repos.targets.listInRange(new Date("2030-01-01T00:00:00Z"), new Date("2030-01-02T00:00:00Z"));
    expect(inRange.map((r) => r.target.id)).toEqual([targets[0]!.id]);
    expect(inRange[0]?.baseText).toBe(post.baseText);
    expect(await repos.targets.listInRange(new Date("2030-02-01T00:00:00Z"), new Date("2030-02-02T00:00:00Z"))).toEqual([]);
    expect(await repos.targets.listInRange(new Date("2030-01-01T00:00:00Z"), new Date("2030-01-02T00:00:00Z"), account.id)).toHaveLength(1);

    expect(await repos.accounts.countUnpublishedPosts(account.id)).toBe(1);
    expect(await repos.accounts.listNeedingReauth()).toEqual([]);
  });
});
