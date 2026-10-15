import { afterAll, describe, expect, it } from "vitest";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";
import { addSlot } from "../../../src/server/services/slots";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";
import { blueskyLikeProvider, instagramLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";

registerTestProvider(instagramLikeProvider);
registerTestProvider(blueskyLikeProvider);

afterAll(async () => {
  await closeDb();
});

async function setup() {
  const env = await postsEnv();
  const connect = (providerKey: string) =>
    accounts.saveConnectedAccount(env.scope, {
      providerKey,
      externalAccountId: `${providerKey}-${Math.random().toString(36).slice(2, 8)}`,
      displayName: providerKey,
      settings: {},
    });
  return { env, connect };
}

const textOf = (detail: Awaited<ReturnType<typeof posts.updatePostText>>) =>
  Object.fromEntries(detail.targets.map((t) => [t.accountId, t.overrideText]));

describe("updatePostText", () => {
  it("edits one account's text and leaves the others with theirs", async () => {
    const { env, connect } = await setup();
    const [a, b] = [await connect("bluesky-like"), await connect("instagram-like")];
    const draft = await posts.createDraft(env.scope, {
      baseText: "base",
      targets: [
        { accountId: a.id, overrideText: "old a" },
        { accountId: b.id, overrideText: "old b" },
      ],
    });
    const detail = await posts.updatePostText(env.scope, draft.post.id, { overrides: { [a.id]: "new a" } });
    expect(textOf(detail)).toEqual({ [a.id]: "new a", [b.id]: "old b" });
  });

  it("edits a scheduled target, which is the whole point of it", async () => {
    const { env, connect } = await setup();
    const a = await connect("bluesky-like");
    await addSlot(env.scope, { accountId: a.id, weekday: 1, localTime: "09:00" });
    const draft = await posts.createDraft(env.scope, { baseText: "base", targets: [{ accountId: a.id, overrideText: "old" }] });
    await atTime(new Date("2026-10-01T12:00:00Z"), () => posts.addToQueue(env.scope, draft.post.id));

    const detail = await posts.updatePostText(env.scope, draft.post.id, { overrides: { [a.id]: "new" } });
    expect(detail.targets[0]).toMatchObject({ status: "scheduled", overrideText: "new" });
  });

  it("keeps the schedule when it edits a scheduled target", async () => {
    const { env, connect } = await setup();
    const a = await connect("bluesky-like");
    await addSlot(env.scope, { accountId: a.id, weekday: 1, localTime: "09:00" });
    const draft = await posts.createDraft(env.scope, { baseText: "base", targets: [{ accountId: a.id }] });
    await atTime(new Date("2026-10-01T12:00:00Z"), () => posts.addToQueue(env.scope, draft.post.id));
    const before = (await posts.getPost(env.scope, draft.post.id)).targets[0]!;

    const detail = await posts.updatePostText(env.scope, draft.post.id, { overrides: { [a.id]: "new" } });
    expect(detail.targets[0]).toMatchObject({ status: "scheduled", scheduledAt: before.scheduledAt, slotId: before.slotId });
  });

  it("does not cancel the targets it was not asked about", async () => {
    const { env, connect } = await setup();
    const [a, b] = [await connect("bluesky-like"), await connect("instagram-like")];
    const draft = await posts.createDraft(env.scope, { baseText: "base", targets: [{ accountId: a.id }, { accountId: b.id }] });

    const detail = await posts.updatePostText(env.scope, draft.post.id, { overrides: { [a.id]: "only a" } });
    expect(detail.targets).toHaveLength(2);
    expect(detail.targets.map((t) => t.status)).toEqual(["draft", "draft"]);
  });

  it("changes the shared text without touching per-account text", async () => {
    const { env, connect } = await setup();
    const [a, b] = [await connect("bluesky-like"), await connect("instagram-like")];
    const draft = await posts.createDraft(env.scope, {
      baseText: "old base",
      targets: [{ accountId: a.id, overrideText: "a only" }, { accountId: b.id }],
    });
    const detail = await posts.updatePostText(env.scope, draft.post.id, { baseText: "new base" });
    expect(detail.post.baseText).toBe("new base");
    expect(textOf(detail)).toEqual({ [a.id]: "a only", [b.id]: null });
  });

  it("drops an account back to the shared text when its override is null", async () => {
    const { env, connect } = await setup();
    const a = await connect("bluesky-like");
    const draft = await posts.createDraft(env.scope, { baseText: "base", targets: [{ accountId: a.id, overrideText: "its own" }] });
    const detail = await posts.updatePostText(env.scope, draft.post.id, { overrides: { [a.id]: null } });
    expect(detail.targets[0]!.overrideText).toBeNull();
  });

  it("refuses an account that is not on the post", async () => {
    const { env, connect } = await setup();
    const [a, stranger] = [await connect("bluesky-like"), await connect("instagram-like")];
    const draft = await posts.createDraft(env.scope, { baseText: "base", targets: [{ accountId: a.id }] });
    await expect(posts.updatePostText(env.scope, draft.post.id, { overrides: { [stranger.id]: "nope" } })).rejects.toThrow();
  });

  it("refuses an empty patch", async () => {
    const { env, connect } = await setup();
    const a = await connect("bluesky-like");
    const draft = await posts.createDraft(env.scope, { baseText: "base", targets: [{ accountId: a.id }] });
    await expect(posts.updatePostText(env.scope, draft.post.id, {})).rejects.toThrow();
  });
});
