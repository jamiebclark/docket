import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as connect from "../../../src/server/services/connect";
import { closeDb } from "../../helpers/db";
import { registerThrowaway, sessionFor, throwawayGroup, unregisterThrowaway } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";

beforeAll(registerThrowaway);
afterAll(async () => {
  unregisterThrowaway();
  await closeDb();
});
afterEach(() => vi.restoreAllMocks());

const callerFor = (userId: string, session: { sessionId: string }) => ({ userId, sessionId: session.sessionId });

async function begin(env: Awaited<ReturnType<typeof postsEnv>>, session: { sessionId: string }) {
  const { url } = await connect.startOAuthConnect(env.scope, { groupKey: "throwaway" }, session);
  return new URL(url).searchParams.get("state")!;
}

describe("G17: the state reaches exchangeCode", () => {
  it("passes the attempt's raw state, once, after validation", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const state = await begin(env, session);
    const exchange = vi.spyOn(throwawayGroup, "exchangeCode");
    await connect.handleOAuthCallback(new URLSearchParams({ state, code: "c" }), callerFor(env.owner.id, session));
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(exchange.mock.calls[0]![0]).toMatchObject({ code: "c", state });
  });

  it("a replayed state never reaches the group again", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const state = await begin(env, session);
    const exchange = vi.spyOn(throwawayGroup, "exchangeCode");
    await connect.handleOAuthCallback(new URLSearchParams({ state, code: "c" }), callerFor(env.owner.id, session));
    const replay = await connect.handleOAuthCallback(new URLSearchParams({ state, code: "c" }), callerFor(env.owner.id, session));
    expect(replay.kind).toBe("invalid");
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("a foreign state (another session) never reaches the group", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const other = await sessionFor(env.owner.id);
    const state = await begin(env, session);
    const exchange = vi.spyOn(throwawayGroup, "exchangeCode");
    const outcome = await connect.handleOAuthCallback(new URLSearchParams({ state, code: "c" }), callerFor(env.owner.id, other));
    expect(outcome.kind).toBe("invalid");
    expect(exchange).not.toHaveBeenCalled();
  });
});
