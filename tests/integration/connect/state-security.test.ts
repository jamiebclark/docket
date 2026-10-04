import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { connectAttempts } from "../../../src/server/db/schema/connect";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { member } from "../../../src/server/db/schema/auth";
import { hashInvitationToken } from "../../../src/server/crypto/tokens";
import * as connect from "../../../src/server/services/connect";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import {
  pageCandidate,
  readyAttempt,
  registerThrowaway,
  sessionFor,
  throwawayGroup,
  unregisterThrowaway,
} from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";

beforeAll(registerThrowaway);
afterAll(async () => {
  unregisterThrowaway();
  await closeDb();
});
afterEach(() => vi.restoreAllMocks());

type Env = Awaited<ReturnType<typeof postsEnv>>;

async function begin(env: Env, session: { sessionId: string }) {
  const { url } = await connect.startOAuthConnect(env.scope, { groupKey: "throwaway" }, session);
  return new URL(url).searchParams.get("state")!;
}

const callerFor = (userId: string, session: { sessionId: string }) => ({ userId, sessionId: session.sessionId });
const accountCount = async (env: Env) =>
  (await testDb().select().from(socialAccounts).where(eq(socialAccounts.projectId, env.project.id))).length;

describe("refused states make no platform call and change nothing", () => {
  async function expectRefused(env: Env, run: (exchange: ReturnType<typeof vi.fn>) => Promise<unknown>, expected: string) {
    const exchange = vi.spyOn(throwawayGroup, "exchangeCode");
    const before = await accountCount(env);
    const outcome = await run(exchange as never);
    expect(outcome).toMatchObject({ kind: expected });
    expect(exchange).not.toHaveBeenCalled();
    expect(await accountCount(env)).toBe(before);
  }

  it.each([
    ["missing", null],
    ["malformed", "not-a-state"],
    ["unknown", "A".repeat(43)],
  ])("%s state", async (_name, state) => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const params = new URLSearchParams({ code: "c" });
    if (state) params.set("state", state);
    await expectRefused(env, () => connect.handleOAuthCallback(params, callerFor(env.owner.id, session)), "invalid");
  });

  it("expired state (more than 10 minutes, by the DB clock)", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const state = await begin(env, session);
    await expectRefused(
      env,
      () => atTime(new Date(Date.now() + 11 * 60_000), () => connect.handleOAuthCallback(new URLSearchParams({ state, code: "c" }), callerFor(env.owner.id, session))),
      "invalid",
    );
  });

  it("reused state", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const state = await begin(env, session);
    const first = await connect.handleOAuthCallback(new URLSearchParams({ state, code: "c" }), callerFor(env.owner.id, session));
    expect(first.kind).not.toBe("invalid");
    await expectRefused(env, () => connect.handleOAuthCallback(new URLSearchParams({ state, code: "c" }), callerFor(env.owner.id, session)), "invalid");
  });

  it("a state started in another session", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const other = await sessionFor(env.owner.id);
    const state = await begin(env, session);
    await expectRefused(env, () => connect.handleOAuthCallback(new URLSearchParams({ state, code: "c" }), callerFor(env.owner.id, other)), "invalid");
  });

  it("a state started by another user", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const state = await begin(env, session);
    const theirs = await sessionFor(env.admin.id);
    await expectRefused(env, () => connect.handleOAuthCallback(new URLSearchParams({ state, code: "c" }), callerFor(env.admin.id, theirs)), "invalid");
  });

  it("a user demoted since starting", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const state = await begin(env, session);
    await testDb()
      .update(member)
      .set({ role: "editor" })
      .where(and(eq(member.organizationId, env.project.id), eq(member.userId, env.owner.id)));
    await expectRefused(env, () => connect.handleOAuthCallback(new URLSearchParams({ state, code: "c" }), callerFor(env.owner.id, session)), "accounts");
  });
});

describe("platform and exchange failures", () => {
  it("a cancelled login returns to accounts, consumes the state and cannot be replayed", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const state = await begin(env, session);
    const exchange = vi.spyOn(throwawayGroup, "exchangeCode");
    const params = new URLSearchParams({ state, error: "access_denied", error_reason: "user_denied" });
    const outcome = await connect.handleOAuthCallback(params, callerFor(env.owner.id, session));
    expect(outcome).toEqual({ kind: "accounts", projectSlug: env.project.slug, code: "platform_error" });
    expect(exchange).not.toHaveBeenCalled();
    const replay = await connect.handleOAuthCallback(new URLSearchParams({ state, code: "c" }), callerFor(env.owner.id, session));
    expect(replay.kind).toBe("invalid");
    expect(exchange).not.toHaveBeenCalled();
    expect(await accountCount(env)).toBe(0);
  });

  it("uses the group's own description of a cancelled login", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const state = await begin(env, session);
    (throwawayGroup as { describeCallbackError?: unknown }).describeCallbackError = () => ({ code: "cancelled", message: "Cancelled." });
    try {
      const outcome = await connect.handleOAuthCallback(new URLSearchParams({ state, error: "access_denied" }), callerFor(env.owner.id, session));
      expect(outcome).toMatchObject({ kind: "accounts", code: "cancelled" });
    } finally {
      delete (throwawayGroup as { describeCallbackError?: unknown }).describeCallbackError;
    }
  });

  it.each([
    ["a refused exchange", () => Promise.resolve({ ok: false as const, message: "bad secret SECRET-VALUE" })],
    ["a thrown exchange", () => Promise.reject(new Error("boom SECRET-VALUE"))],
  ])("%s leaves nothing changed and leaks nothing", async (_n, impl) => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const state = await begin(env, session);
    vi.spyOn(throwawayGroup, "exchangeCode").mockImplementation(impl as never);
    const outcome = await connect.handleOAuthCallback(new URLSearchParams({ state, code: "c" }), callerFor(env.owner.id, session));
    expect(outcome).toEqual({ kind: "accounts", projectSlug: env.project.slug, code: "exchange_failed" });
    expect(JSON.stringify(outcome)).not.toContain("SECRET-VALUE");
    expect(await accountCount(env)).toBe(0);
    const [row] = await testDb().select().from(connectAttempts).where(and(eq(connectAttempts.projectId, env.project.id), eq(connectAttempts.stateHash, hashInvitationToken(state))));
    expect(row?.candidatesEncrypted).toBeNull();
  });

  it("a good exchange stores encrypted candidates and points at the chooser", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const state = await begin(env, session);
    vi.spyOn(throwawayGroup, "exchangeCode").mockResolvedValue({ ok: true, candidates: pageCandidate("700", "Acme") });
    const outcome = await connect.handleOAuthCallback(new URLSearchParams({ state, code: "c" }), callerFor(env.owner.id, session));
    expect(outcome.kind).toBe("chooser");
    if (outcome.kind !== "chooser") return;
    const [row] = await testDb().select().from(connectAttempts).where(and(eq(connectAttempts.projectId, env.project.id), eq(connectAttempts.id, outcome.attemptId)));
    expect(row?.candidatesEncrypted).toBeTruthy();
    expect(row?.candidatesEncrypted).not.toContain("PAGE-TOKEN");
    const choice = await connect.getConnectChoice(env.scope, outcome.attemptId, session);
    expect(choice?.candidates).toHaveLength(2);
  });
});

describe("expiry", () => {
  it("an unsubmitted attempt can no longer be chosen and its candidates are purged", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const id = await readyAttempt(env.scope, session, pageCandidate("800", "Acme", false));
    const later = new Date(Date.now() + 11 * 60_000);
    await atTime(later, async () => {
      expect(await connect.getConnectChoice(env.scope, id, session)).toBeNull();
      const r = await connect.chooseConnectCandidates(env.scope, { attemptId: id, selected: ["tw-page:800"] }, session);
      expect(r.ok).toBe(false);
    });
    expect(await accountCount(env)).toBe(0);
    // Starting any later attempt purges attempts that expired over an hour ago.
    await atTime(new Date(Date.now() + 3 * 3_600_000), () => connect.startOAuthConnect(env.scope, { groupKey: "throwaway" }, session));
    const rows = await testDb().select().from(connectAttempts).where(and(eq(connectAttempts.projectId, env.project.id), eq(connectAttempts.id, id)));
    expect(rows).toHaveLength(0);
  });
});
