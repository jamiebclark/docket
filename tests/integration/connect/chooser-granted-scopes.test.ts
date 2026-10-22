import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import type { ConnectCandidate } from "../../../src/providers/types";
import * as connect from "../../../src/server/services/connect";
import { closeDb, testDb } from "../../helpers/db";
import { readyAttempt, registerThrowaway, sessionFor, unregisterThrowaway } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";

beforeAll(registerThrowaway);
afterAll(async () => {
  unregisterThrowaway();
  await closeDb();
});

const candidate = (id: string, grantedScopes?: readonly string[]): ConnectCandidate[] => [
  {
    providerKey: "tw-page",
    externalId: id,
    displayName: `Page ${id}`,
    settings: {},
    credentials: { pageToken: `PAGE-TOKEN-${id}` },
    expiresAt: null,
    notes: ["No photo account is linked."],
    ...(grantedScopes ? { grantedScopes } : {}),
  },
];

const storedScopes = async (projectId: string, externalId: string) => {
  const [row] = await testDb()
    .select()
    .from(socialAccounts)
    .where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.externalAccountId, externalId)));
  return row?.grantedScopes ?? null;
};

/**
 * The provider works out which permissions a login actually granted, and the gate reads the stored
 * list to decide whether a surface can be called. Between them sits the chooser, and it dropped the
 * value on the floor: `saveConnectedAccountSchema` never named `grantedScopes`, so zod stripped it
 * before `saveConnectedAccountTx` could pass it on.
 *
 * Nothing failed. Accounts connected, posts published, and every permission-gated surface reported
 * "needs a reconnect" forever, because a reconnect could not record a grant either. On the install
 * that found this, all sixteen accounts across four brands and four providers had a null list —
 * the column had never once been written by this path.
 *
 * Both ends were tested: `granted-scopes.test.ts` covers the refresh path, and the DAL has its own
 * normalization tests. This is the hop between them.
 */
describe("the chooser stores the permissions the provider reported (G31)", () => {
  it("persists a candidate's grantedScopes", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const granted = ["pages_show_list", "pages_read_engagement", "pages_read_user_content"];

    const id = await readyAttempt(env.scope, session, candidate("4001", granted));
    const result = await connect.chooseConnectCandidates(env.scope, { attemptId: id, selected: ["tw-page:4001"] }, session);
    expect(result.ok).toBe(true);

    expect(await storedScopes(env.project.id, "4001")).toEqual(granted);
  });

  it("stores an empty list as empty, which is not the same as never having been told", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);

    const id = await readyAttempt(env.scope, session, candidate("4002", []));
    expect((await connect.chooseConnectCandidates(env.scope, { attemptId: id, selected: ["tw-page:4002"] }, session)).ok).toBe(true);

    // [] means "it granted nothing"; null means "nobody said" — the gate treats these differently.
    expect(await storedScopes(env.project.id, "4002")).toEqual([]);
  });

  it("leaves it unset when the provider reported nothing", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);

    const id = await readyAttempt(env.scope, session, candidate("4003"));
    expect((await connect.chooseConnectCandidates(env.scope, { attemptId: id, selected: ["tw-page:4003"] }, session)).ok).toBe(true);

    expect(await storedScopes(env.project.id, "4003")).toBeNull();
  });

  it("records the new list when the same account is connected again with more permissions", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);

    const first = await readyAttempt(env.scope, session, candidate("4004", ["pages_show_list"]));
    expect((await connect.chooseConnectCandidates(env.scope, { attemptId: first, selected: ["tw-page:4004"] }, session)).ok).toBe(true);
    expect(await storedScopes(env.project.id, "4004")).toEqual(["pages_show_list"]);

    // This is what a reconnect is for: the member granted something new, and it has to land.
    const widened = ["pages_show_list", "pages_read_user_content"];
    const second = await readyAttempt(env.scope, session, candidate("4004", widened));
    expect((await connect.chooseConnectCandidates(env.scope, { attemptId: second, selected: ["tw-page:4004"] }, session)).ok).toBe(true);
    expect(await storedScopes(env.project.id, "4004")).toEqual(widened);
  });
});
