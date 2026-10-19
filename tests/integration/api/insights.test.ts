import { afterAll, describe, expect, it, vi } from "vitest";
import { OPERATIONS } from "../../../src/server/api/operations";
import { buildAccountTrends, buildComparisons } from "../../../src/server/services/insights/view";
import { api, createKey } from "../../helpers/api";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(closeDb);

const NOW = new Date("2026-10-18T12:00:00Z");
const DAY_MS = 86_400_000;
const RANGE = { from: "2026-09-19", to: "2026-10-18" };

type Env = Awaited<ReturnType<typeof postsEnv>>;

async function publish(
  env: Pick<Env, "scope">,
  accountId: string,
  opts: { origin?: "manual" | "generated" | "api"; value?: number; publishedAt?: Date } = {},
) {
  const post = await env.scope.posts.insert({ baseText: "A post.", origin: opts.origin ?? "manual", generationMetadata: null as never });
  const [target] = await env.scope.targets.insertMany([{ postId: post.id, socialAccountId: accountId }]);
  await env.scope.targets.update(target!.id, {
    status: "published",
    externalId: `ext-${post.id}`,
    publishedAt: opts.publishedAt ?? NOW,
    scheduleKind: "now",
    slotOccurrenceAt: null,
  });
  await env.scope.posts.setStatus(post.id, "published");
  await env.scope.postMetricSnapshots.insertIfAbsent({
    postTargetId: target!.id,
    socialAccountId: accountId,
    providerKey: "mock",
    capturedAt: opts.publishedAt ?? NOW,
    metrics: { likeCount: opts.value ?? 10 },
  });
  return { post, target: target! };
}

describe("GET /insights (US7, contracts/insights-api.md §6)", () => {
  it("matches the figures the service the screen calls returns, for the same project and range (US7.1)", async () => {
    const env = await postsEnv();
    const account = await env.account({}, false);
    await env.scope.accountMetricSnapshots.insertIfAbsent({ socialAccountId: account.id, providerKey: "mock", capturedAt: NOW, metrics: { followersCount: 42 } });
    const key = (await createKey(env.scope, ["read"])).secret;

    const r = await api("GET", `/insights?from=${RANGE.from}&to=${RANGE.to}`, { key });
    expect(r.status).toBe(200);

    const { series } = await buildAccountTrends({
      projectId: env.project.id,
      timeZone: env.project.timezone,
      accounts: [{ id: account.id, displayName: account.displayName, providerKey: account.providerKey }],
      range: { from: new Date(RANGE.from), to: new Date(new Date(RANGE.to).getTime() + DAY_MS) },
      accountMetricPollStates: env.scope.accountMetricPollStates,
    });
    const followers = series.find((s) => s.metricKey === "followersCount")!;
    const apiTrend = r.json.trends.find((t: { metricKey: string }) => t.metricKey === "followersCount");
    expect(apiTrend.accountId).toBe(followers.accountId);
    expect(apiTrend.points).toEqual(followers.points.map((p) => ({ day: p.day, value: p.value, capturedAt: p.capturedAt.toISOString() })));
  });

  it("gives a key for one project nothing of another (US7.2)", async () => {
    const a = await postsEnv();
    const b = await postsEnv();
    const accountA = await a.account({}, false);
    const accountB = await b.account({}, false);
    await a.scope.accountMetricSnapshots.insertIfAbsent({ socialAccountId: accountA.id, providerKey: "mock", capturedAt: NOW, metrics: { followersCount: 1 } });
    await b.scope.accountMetricSnapshots.insertIfAbsent({ socialAccountId: accountB.id, providerKey: "mock", capturedAt: NOW, metrics: { followersCount: 2 } });
    const keyA = (await createKey(a.scope, ["read"])).secret;

    const r = await api("GET", `/insights?from=${RANGE.from}&to=${RANGE.to}`, { key: keyA });
    expect(r.status).toBe(200);
    expect(r.json.trends.some((t: { accountId: string }) => t.accountId === accountB.id)).toBe(false);
  });

  it("refuses a key without read (US7.3)", async () => {
    const env = await postsEnv();
    const key = (await createKey(env.scope, ["write_posts"])).secret;
    const r = await api("GET", "/insights", { key });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("missing_permission");
  });

  it("returns conclusion: not_enough_posts with counts and no ordering below the floor (US7.4)", async () => {
    const env = await postsEnv();
    const account = await env.account({}, false);
    for (let i = 0; i < 4; i++) await publish(env, account.id, { origin: "manual" });
    for (let i = 0; i < 4; i++) await publish(env, account.id, { origin: "generated" });
    const key = (await createKey(env.scope, ["read"])).secret;

    const r = await api("GET", `/insights?from=${RANGE.from}&to=${RANGE.to}&dimension=origin`, { key });
    expect(r.status).toBe(200);
    const byOrigin = r.json.comparisons.find((c: { dimension: string; metricKey: string }) => c.dimension === "origin" && c.metricKey === "likeCount");
    expect(byOrigin.conclusion).toBe("not_enough_posts");
    expect(byOrigin.groups.every((g: { sampleSize: number }) => typeof g.sampleSize === "number")).toBe(true);
    const labels = byOrigin.groups.map((g: { label: string }) => g.label);
    expect(labels).toEqual([...labels].sort((x, y) => x.localeCompare(y)));
    for (const g of byOrigin.groups) expect(g).not.toHaveProperty("rank");

    const direct = await buildComparisons({ projectId: env.project.id, timeZone: env.project.timezone, range: { from: new Date(RANGE.from), to: new Date(new Date(RANGE.to).getTime() + DAY_MS) } });
    expect(direct.find((c) => c.dimension === "origin" && c.metricKey === "likeCount")?.conclusion).toBe("not_enough_posts");
  });

  it("appears in the operations table, exposed over MCP, and reachable over REST (US7.5, SC-008)", async () => {
    const op = OPERATIONS.find((o) => o.id === "getInsights");
    expect(op).toBeTruthy();
    expect(op!.method).toBe("GET");
    expect(op!.path).toBe("/insights");
    expect(op!.mcp).toEqual({ expose: true });

    const env = await postsEnv();
    const key = (await createKey(env.scope, ["read"])).secret;
    const r = await api("GET", "/insights", { key });
    expect(r.status).toBe(200);
  });

  it("never echoes a credential, token or raw provider payload (US7.6, FR-064, FR-084)", async () => {
    const env = await postsEnv();
    const account = await env.account({}, false);
    await env.scope.accountMetricSnapshots.insertIfAbsent({ socialAccountId: account.id, providerKey: "mock", capturedAt: NOW, metrics: { followersCount: 7 } });
    await publish(env, account.id);
    const key = (await createKey(env.scope, ["read"])).secret;

    const r = await api("GET", `/insights?from=${RANGE.from}&to=${RANGE.to}`, { key });
    expect(r.status).toBe(200);
    const lower = r.text.toLowerCase();
    for (const needle of ["credential", "accesstoken", "access_token", "refreshtoken", "refresh_token", "clientsecret", "client_secret", "bearer ", "dkt_"]) {
      expect(lower, needle).not.toContain(needle);
    }
  });

  it("makes no platform HTTP call while serving it (SC-011)", async () => {
    const env = await postsEnv();
    const account = await env.account({}, false);
    await env.scope.accountMetricSnapshots.insertIfAbsent({ socialAccountId: account.id, providerKey: "mock", capturedAt: NOW, metrics: { followersCount: 7 } });
    await publish(env, account.id);
    const key = (await createKey(env.scope, ["read"])).secret;

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const r = await api("GET", `/insights?from=${RANGE.from}&to=${RANGE.to}`, { key });
      expect(r.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
