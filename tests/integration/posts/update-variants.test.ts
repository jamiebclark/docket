import { afterAll, describe, expect, it } from "vitest";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";
import { blueskyLikeProvider, instagramLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import * as accounts from "../../../src/server/services/accounts";

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

describe("updatePostVariants", () => {
  it("updates every target of the listed accounts and leaves the others alone", async () => {
    const { env, connect } = await setup();
    const [a, b, c] = [await connect("bluesky-like"), await connect("bluesky-like"), await connect("instagram-like")];
    const draft = await posts.createDraft(env.scope, {
      baseText: "base",
      targets: [
        { accountId: a.id, overrideText: "old a" },
        { accountId: b.id, overrideText: "old b" },
        { accountId: c.id, overrideText: "old c" },
      ],
    });
    const res = await posts.updatePostVariants(env.scope, draft.post.id, {
      edits: [{ accountIds: [a.id, b.id], text: "new text" }],
    });
    const text = Object.fromEntries(res.detail.targets.map((t) => [t.accountId, t.overrideText]));
    expect(text).toEqual({ [a.id]: "new text", [b.id]: "new text", [c.id]: "old c" });
    expect(res.problems).toEqual([]);
  });

  it("returns blocking problems for the edited accounts", async () => {
    const { env, connect } = await setup();
    const insta = await connect("instagram-like");
    const draft = await posts.createDraft(env.scope, { baseText: "base", targets: [{ accountId: insta.id }] });
    const res = await posts.updatePostVariants(env.scope, draft.post.id, {
      edits: [{ accountIds: [insta.id], text: "x".repeat(600) }],
    });
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]!.accountIds).toEqual([insta.id]);
    expect(res.problems[0]!.issues[0]!.severity).toBe("error");
  });

  it("does not edit a scheduled target", async () => {
    const { env, connect } = await setup();
    const a = await connect("bluesky-like");
    await (await import("../../../src/server/services/slots")).addSlot(env.scope, { accountId: a.id, weekday: 1, localTime: "09:00" });
    const draft = await posts.createDraft(env.scope, { baseText: "base", targets: [{ accountId: a.id, overrideText: "keep" }] });
    await atTime(new Date("2026-10-01T12:00:00Z"), () => posts.addToQueue(env.scope, draft.post.id));
    const res = await posts.updatePostVariants(env.scope, draft.post.id, { edits: [{ accountIds: [a.id], text: "changed" }] });
    expect(res.detail.targets[0]).toMatchObject({ status: "scheduled", overrideText: "keep" });
  });
});
