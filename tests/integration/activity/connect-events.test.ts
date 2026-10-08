import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { findProvider } from "../../../src/providers/registry";
import { CONNECT_BANNER } from "../../../src/lib/accounts/connect-banner-text";
import * as accounts from "../../../src/server/services/accounts";
import * as connect from "../../../src/server/services/connect";
import { dump, eventsFor } from "../../helpers/activity";
import { closeDb } from "../../helpers/db";
import { pageCandidate, registerThrowaway, sessionFor, strictGroup, throwawayGroup, unregisterThrowaway } from "../../helpers/connect-group";
import { createFakePds, mintJwt, type FakePds } from "../../helpers/fake-pds";
import { postsEnv } from "../../helpers/posts-env";

beforeAll(registerThrowaway);
afterAll(async () => {
  unregisterThrowaway();
  await closeDb();
});

let pds: FakePds;
beforeEach(() => {
  pds = createFakePds();
  vi.stubGlobal("fetch", pds.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete throwawayGroup.describeCallbackError;
});

const caller = (userId: string, session: { sessionId: string }) => ({ userId, sessionId: session.sessionId });

async function callback(
  env: Awaited<ReturnType<typeof postsEnv>>,
  extra: Record<string, string>,
  opts: { group?: string; session?: { sessionId: string } } = {},
) {
  const session = opts.session ?? (await sessionFor(env.owner.id));
  const { url } = await connect.startOAuthConnect(env.scope, { groupKey: opts.group ?? "throwaway" }, session);
  const state = new URL(url).searchParams.get("state")!;
  const outcome = await connect.handleOAuthCallback(new URLSearchParams({ state, ...extra }), caller(env.owner.id, session));
  return { outcome, state, session };
}

describe("OAuth connect failures", () => {
  it("platform_error: the stored message is the banner text, and the platform's own text wins", async () => {
    const env = await postsEnv();
    await callback(env, { error: "access_denied" });
    const [generic] = await eventsFor(env.project.id);
    expect(generic).toMatchObject({
      kind: "account_connect_failed",
      outcome: "connect_failed",
      groupKey: "throwaway",
      actorUserId: env.owner.id,
      providerKey: null,
      providerKeys: ["tw-page", "tw-photo"],
      details: { via: "oauth", code: "platform_error" },
      message: CONNECT_BANNER.platform_error,
    });

    throwawayGroup.describeCallbackError = () => ({ code: "platform_error", message: "The app is in development mode." });
    await callback(env, { error: "access_denied" });
    const [, own] = await eventsFor(env.project.id);
    expect(own!.message).toBe("The app is in development mode.");
  });

  it("exchange_failed (thrown and refused), no_candidates and too_many", async () => {
    const env = await postsEnv();
    vi.spyOn(throwawayGroup, "exchangeCode").mockRejectedValueOnce(new Error("socket hang up code=SECRETCODE"));
    await callback(env, { code: "SECRETCODE" });
    vi.spyOn(throwawayGroup, "exchangeCode").mockResolvedValueOnce({ ok: false, message: "Bad client secret hunter2" });
    await callback(env, { code: "c2" });
    vi.spyOn(throwawayGroup, "exchangeCode").mockResolvedValueOnce({ ok: true, candidates: [] });
    await callback(env, { code: "c3" });
    const many = Array.from({ length: 501 }, (_, i) => pageCandidate(`p${i}`, `Page ${i}`, false)[0]!);
    vi.spyOn(throwawayGroup, "exchangeCode").mockResolvedValueOnce({ ok: true, candidates: many });
    await callback(env, { code: "c4" });

    const events = await eventsFor(env.project.id);
    expect(events.map((e) => (e.details as { code: string }).code)).toEqual(["exchange_failed", "exchange_failed", "no_candidates", "too_many"]);
    expect(events[0]!.message).toBe(CONNECT_BANNER.exchange_failed);
    expect(events[1]!.message).toBe("Bad client secret hunter2");
    expect(events[2]!.message).toBe(CONNECT_BANNER.no_candidates);
    expect(events[3]!.message).toBe(CONNECT_BANNER.too_many);
    expect(dump(events)).not.toContain("SECRETCODE");
  });

  it("a platform message that echoes the code or state is redacted", async () => {
    const env = await postsEnv();
    vi.spyOn(throwawayGroup, "exchangeCode").mockImplementationOnce(async ({ code, state }) => ({
      ok: false,
      message: `Invalid code ${code} for state ${state}`,
    }));
    const { state } = await callback(env, { code: "AUTHCODE-123" });
    const [e] = await eventsFor(env.project.id);
    expect(e!.message).not.toContain("AUTHCODE-123");
    expect(e!.message).not.toContain(state);
  });

  it("writes none for cancelled, forged, unknown, reused, foreign state or a successful chooser", async () => {
    const env = await postsEnv();
    throwawayGroup.describeCallbackError = () => ({ code: "cancelled", message: "Cancelled" });
    const cancelled = await callback(env, { error: "access_denied" });
    expect(cancelled.outcome).toMatchObject({ kind: "accounts", code: "cancelled" });

    delete throwawayGroup.describeCallbackError;
    const session = await sessionFor(env.owner.id);
    vi.spyOn(throwawayGroup, "exchangeCode").mockResolvedValueOnce({ ok: true, candidates: pageCandidate("1", "A", false) });
    const good = await callback(env, { code: "ok" }, { session });
    expect(good.outcome.kind).toBe("chooser");
    const reused = await connect.handleOAuthCallback(new URLSearchParams({ state: good.state, error: "x" }), caller(env.owner.id, session));
    expect(reused.kind).toBe("invalid");
    expect((await connect.handleOAuthCallback(new URLSearchParams({ state: "x".repeat(43), error: "x" }), caller(env.owner.id, session))).kind).toBe("invalid");
    expect((await connect.handleOAuthCallback(new URLSearchParams({ error: "x" }), caller(env.owner.id, session))).kind).toBe("invalid");

    const other = await sessionFor(env.owner.id);
    const { url } = await connect.startOAuthConnect(env.scope, { groupKey: "throwaway" }, session);
    const foreign = await connect.handleOAuthCallback(
      new URLSearchParams({ state: new URL(url).searchParams.get("state")!, error: "x" }),
      caller(env.owner.id, other),
    );
    expect(foreign.kind).toBe("invalid");

    expect(await eventsFor(env.project.id)).toHaveLength(0);
  });

  it("not_allowed (an editor) writes none", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.editor.id);
    const ownerScope = env.scope;
    const { url } = await connect.startOAuthConnect(ownerScope, { groupKey: "throwaway" }, session);
    const state = new URL(url).searchParams.get("state")!;
    // The attempt belongs to the owner's user id, so the editor's callback is not even valid.
    const out = await connect.handleOAuthCallback(new URLSearchParams({ state, error: "x" }), { userId: env.editor.id, sessionId: session.sessionId });
    expect(out.kind).toBe("invalid");
    expect(await eventsFor(env.project.id)).toHaveLength(0);
  });
});

describe("paste connect failures", () => {
  it("refused, unreachable, none and too many; the pasted token never lands in the log", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const paste = strictGroup.pasteToken!;
    const token = "EAAB-pasted-secret-token";
    vi.spyOn(paste, "exchange").mockResolvedValueOnce({ ok: false, message: `Token ${token} is invalid` });
    vi.spyOn(paste, "exchange").mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(paste, "exchange").mockResolvedValueOnce({ ok: true, candidates: [] });
    vi.spyOn(paste, "exchange").mockResolvedValueOnce({
      ok: true,
      candidates: Array.from({ length: 501 }, (_, i) => pageCandidate(`p${i}`, `Page ${i}`, false)[0]!),
    });
    for (let i = 0; i < 4; i++) await connect.pasteConnectToken(env.scope, { groupKey: "throwaway-strict", token }, session);

    const events = await eventsFor(env.project.id);
    expect(events.map((e) => e.details)).toEqual([
      { via: "paste", code: "paste_refused" },
      { via: "paste", code: "paste_unreachable" },
      { via: "paste", code: "paste_none" },
      { via: "paste", code: "paste_too_many" },
    ]);
    expect(events.every((e) => e.groupKey === "throwaway-strict" && e.actorUserId === env.owner.id)).toBe(true);
    expect(dump(events)).not.toContain(token);
  });

  it("local validation (empty token) writes none", async () => {
    const env = await postsEnv();
    const out = await connect.pasteConnectToken(env.scope, { groupKey: "throwaway-strict", token: "   " }, await sessionFor(env.owner.id));
    expect(out.ok).toBe(false);
    expect(await eventsFor(env.project.id)).toHaveLength(0);
  });
});

describe("credential connect failures", () => {
  const PASSWORD = "abcd-efgh-ijkl-mnop";
  const CREATE = "/xrpc/com.atproto.server.createSession";
  const session = (did = "did:plc:alice", handle = "alice.bsky.social") => ({
    accessJwt: mintJwt(new Date("2030-01-01T01:00:00Z")),
    refreshJwt: mintJwt(new Date("2030-03-01T00:00:00Z")),
    did,
    handle,
  });
  const input = (fields: Record<string, string> = {}, accountId?: string) => ({
    providerKey: "bluesky",
    fields: { handle: "Alice.bsky.social", appPassword: PASSWORD, pdsUrl: "", ...fields },
    ...(accountId ? { accountId } : {}),
  });

  it("refused, unreachable (thrown) and different account; field validation writes none", async () => {
    const env = await postsEnv();
    pds.route("POST", CREATE, { status: 401, json: { error: "AuthenticationRequired", message: `no ${PASSWORD}` } });
    await accounts.connectWithCredentials(env.scope, input());
    vi.spyOn(findProvider("bluesky")!, "connectAccount").mockRejectedValueOnce(new Error("boom"));
    await accounts.connectWithCredentials(env.scope, input());
    vi.restoreAllMocks();

    pds.route("POST", CREATE, [{ json: session() }, { json: session("did:plc:bob", "bob.bsky.social") }]);
    const first = await accounts.connectWithCredentials(env.scope, input());
    if (!first.ok) throw new Error("setup");
    await accounts.connectWithCredentials(env.scope, input({ handle: "bob.bsky.social" }, first.account.id));
    await accounts.connectWithCredentials(env.scope, input({ handle: "" })); // field validation

    const events = await eventsFor(env.project.id);
    expect(events.map((e) => e.details)).toEqual([
      { via: "credentials", code: "credentials_refused" },
      { via: "credentials", code: "credentials_unreachable" },
      { via: "credentials", code: "different_account" },
    ]);
    expect(events[0]).toMatchObject({ providerKey: "bluesky", providerKeys: ["bluesky"], actorUserId: env.owner.id });
    expect(events[2]!.socialAccountId).toBe(first.account.id);
    expect(dump(events)).not.toContain(PASSWORD);
  });
});
