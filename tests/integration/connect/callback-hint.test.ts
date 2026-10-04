import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import AccountsPage from "../../../src/app/p/[projectSlug]/accounts/page";
import { GET } from "../../../src/app/connect/callback/route";
import * as connect from "../../../src/server/services/connect";
import { closeDb } from "../../helpers/db";
import { registerThrowaway, sessionFor, strictGroup, unregisterThrowaway } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";

const HINT = strictGroup.callbackHint!;
const saved = { requirement: strictGroup.redirectRequirement, describe: strictGroup.describeCallbackError };

beforeAll(() => {
  registerThrowaway();
  // The test address is http://localhost, so lift the requirement to let an attempt start.
  strictGroup.redirectRequirement = undefined;
  strictGroup.describeCallbackError = (p) => ({ code: p.get("error") === "access_denied" ? "cancelled" : "platform_error", message: "" });
});
afterAll(async () => {
  strictGroup.redirectRequirement = saved.requirement;
  strictGroup.describeCallbackError = saved.describe;
  unregisterThrowaway();
  await closeDb();
});

async function withSession<T>(userId: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
  const { sessionModule } = await import("../../helpers/actions");
  const original = sessionModule.getSession;
  sessionModule.getSession = (async () => ({ user: { id: userId }, session: { id: sessionId } })) as never;
  try {
    return await fn();
  } finally {
    sessionModule.getSession = original;
  }
}

/** Starts a real attempt, lands the platform callback with `extra`, and returns the redirect's search params. */
async function callback(extra: string): Promise<URLSearchParams> {
  const env = await postsEnv();
  const session = await sessionFor(env.owner.id);
  const { url } = await connect.startOAuthConnect(env.scope, { groupKey: "throwaway-strict" }, session);
  const state = new URL(url).searchParams.get("state")!;
  const res = await withSession(env.owner.id, session.sessionId, () =>
    GET(new NextRequest(`http://localhost:3000/connect/callback?state=${state}&${extra}`)),
  );
  const location = new URL(res.headers.get("location")!);
  expect(location.pathname).toBe(`/p/${env.project.slug}/accounts`);
  return location.searchParams;
}

async function renderAccounts(query: Record<string, string>): Promise<string> {
  const env = await postsEnv();
  const session = await sessionFor(env.owner.id);
  return withSession(env.owner.id, session.sessionId, async () =>
    renderToStaticMarkup(await AccountsPage({ params: Promise.resolve({ projectSlug: env.project.slug }), searchParams: Promise.resolve(query) })),
  );
}

describe("callback redirect carries the registered group key", () => {
  it("adds only the stored group key, not platform text", async () => {
    const q = await callback("error=server_error&error_description=" + encodeURIComponent("<b>evil</b>"));
    expect([...q.keys()].sort()).toEqual(["connect", "group"]);
    expect(q.get("connect")).toBe("platform_error");
    expect(q.get("group")).toBe("throwaway-strict");
  });
  it("reports a cancelled login as cancelled", async () => {
    expect((await callback("error=access_denied")).get("connect")).toBe("cancelled");
  });
  it("reports an empty candidate list as no_candidates", async () => {
    expect((await callback("code=abc")).get("connect")).toBe("no_candidates");
  });
});

describe("accounts banner hint", () => {
  it.each(["platform_error", "exchange_failed", "no_candidates"])("shows the hint for %s", async (code) => {
    expect(await renderAccounts({ connect: code, group: "throwaway-strict" })).toContain(HINT);
  });
  it.each(["cancelled", "too_many", "not_allowed"])("does not show the hint for %s", async (code) => {
    const html = await renderAccounts({ connect: code, group: "throwaway-strict" });
    expect(html).not.toContain(HINT);
  });
  it("shows nothing extra for an unknown or hint-less group", async () => {
    expect(await renderAccounts({ connect: "platform_error", group: "no-such-group" })).not.toContain(HINT);
    const plain = await renderAccounts({ connect: "platform_error", group: "throwaway" });
    expect(plain).toContain("The platform returned an error.");
    expect(plain).not.toContain(HINT);
  });
});
