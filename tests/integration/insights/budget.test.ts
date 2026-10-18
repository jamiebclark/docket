import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeGraph, type FakeGraph } from "../../helpers/fake-graph";
import { classifyGraphError } from "../../../src/providers/meta/errors";
import { facebookInsights } from "../../../src/providers/facebook/insights";
import { instagramInsights } from "../../../src/providers/instagram/insights";
import { resetUsageBackoffs } from "../../../src/providers/meta/usage";

const IG = "17841400000000000";
const MEDIA = "18000000000000000";
const PAGE_POST = "999_1";
const TOKEN = "EAAB-page-token-0123456789abcdef";
const NOW = new Date("2026-05-01T00:00:00Z");

const ENV_KEYS = ["META_APP_ID", "META_APP_SECRET", "META_INSIGHTS_USAGE_CEILING"] as const;
const ORIGINAL: Record<string, string | undefined> = {};

let fake: FakeGraph;
beforeEach(() => {
  for (const k of ENV_KEYS) ORIGINAL[k] = process.env[k];
  process.env.META_APP_ID = "12345";
  process.env.META_APP_SECRET = "a".repeat(32);
  delete process.env.META_INSIGHTS_USAGE_CEILING;
  resetUsageBackoffs();
  fake = createFakeGraph().install();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
  resetUsageBackoffs();
  fake.uninstall();
});

const p = (path: string) => `/v26.0${path}`;
const account = (id: string, externalId: string) => ({
  id,
  externalId,
  displayName: "Test account",
  settings: {},
  credentials: { pageToken: TOKEN },
});

describe("budget (contracts/meta-usage.md, FR-045 … FR-048, US6)", () => {
  it("a 200 at or above the ceiling still commits this read; the next read for the account is not made and comes back rate_limited with the header's retryAt (US6-AS1)", async () => {
    fake.on("GET", p(`/${MEDIA}/insights`), {
      kind: "ok",
      body: { data: [{ name: "views", values: [{ value: 42 }] }] },
      headers: { "x-business-use-case-usage": JSON.stringify({ [IG]: [{ call_count: 85, estimated_time_to_regain_access: 30 }] }) },
    });

    const first = await instagramInsights.readPostMetrics({
      account: account("acct-budget-1", IG),
      posts: [{ externalId: MEDIA }],
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(first).toMatchObject({ kind: "page", entries: [{ externalId: MEDIA, kind: "metrics", metrics: { views: 42 } }] });
    expect(fake.requests).toHaveLength(1);

    const second = await instagramInsights.readPostMetrics({
      account: account("acct-budget-1", IG),
      posts: [{ externalId: MEDIA }],
      now: new Date(NOW.getTime() + 1_000),
      signal: new AbortController().signal,
    });
    expect(second).toMatchObject({ kind: "rate_limited", retryAt: new Date(NOW.getTime() + 30 * 60_000) });
    expect(fake.requests).toHaveLength(1); // the second read never reached Graph

    const forAccount = await instagramInsights.readAccountMetrics({
      account: account("acct-budget-1", IG),
      now: new Date(NOW.getTime() + 1_000),
      signal: new AbortController().signal,
    });
    expect(forAccount).toMatchObject({ kind: "rate_limited" });
    expect(fake.requests).toHaveLength(1); // same account, still backing off

    // a different account is unaffected
    fake.on("GET", p(`/${PAGE_POST}/insights`), { kind: "ok", body: { data: [] } });
    const other = await facebookInsights.readPostMetrics({
      account: account("acct-budget-2", "999"),
      posts: [{ externalId: PAGE_POST }],
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(other.kind).toBe("page");
  });

  it("no usage header at all leaves the declared floor and reserve as the only bound (US6-AS4)", async () => {
    fake.on("GET", p(`/${MEDIA}/insights`), { kind: "ok", body: { data: [{ name: "views", values: [{ value: 1 }] }] } });

    const result = await instagramInsights.readPostMetrics({
      account: account("acct-budget-3", IG),
      posts: [{ externalId: MEDIA }],
      now: NOW,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("page");

    const again = await instagramInsights.readPostMetrics({
      account: account("acct-budget-3", IG),
      posts: [{ externalId: MEDIA }],
      now: new Date(NOW.getTime() + 1_000),
      signal: new AbortController().signal,
    });
    expect(again.kind).toBe("page");
    expect(fake.requests).toHaveLength(2);
  });

  it("a ceiling-reaching usage header with no estimated_time_to_regain_access does not set a cross-call backoff", async () => {
    fake.on("GET", p(`/${MEDIA}/insights`), {
      kind: "ok",
      body: { data: [{ name: "views", values: [{ value: 1 }] }] },
      headers: { "x-business-use-case-usage": JSON.stringify({ [IG]: [{ call_count: 99 }] }) },
    });

    await instagramInsights.readPostMetrics({
      account: account("acct-budget-4", IG),
      posts: [{ externalId: MEDIA }],
      now: NOW,
      signal: new AbortController().signal,
    });
    const again = await instagramInsights.readPostMetrics({
      account: account("acct-budget-4", IG),
      posts: [{ externalId: MEDIA }],
      now: new Date(NOW.getTime() + 1_000),
      signal: new AbortController().signal,
    });
    expect(again.kind).toBe("page");
    expect(fake.requests).toHaveLength(2);
  });

  it("the rate-limited result never carries the token or any raw header text (FR-048, US6-AS5)", async () => {
    fake.on("GET", p(`/${MEDIA}/insights`), {
      kind: "ok",
      body: { data: [] },
      headers: { "x-business-use-case-usage": JSON.stringify({ [IG]: [{ call_count: 90, estimated_time_to_regain_access: 5 }] }) },
    });
    await instagramInsights.readPostMetrics({
      account: account("acct-budget-5", IG),
      posts: [{ externalId: MEDIA }],
      now: NOW,
      signal: new AbortController().signal,
    });
    const limited = await instagramInsights.readPostMetrics({
      account: account("acct-budget-5", IG),
      posts: [{ externalId: MEDIA }],
      now: new Date(NOW.getTime() + 1_000),
      signal: new AbortController().signal,
    });
    expect(JSON.stringify(limited)).not.toContain(TOKEN);
    expect(JSON.stringify(limited).length).toBeLessThan(500);
  });

  it("Graph error codes 80001 and 80002 remain classified rate_limited (FR-046; full coverage in src/providers/meta/errors.test.ts)", () => {
    for (const code of [80001, 80002]) {
      expect(classifyGraphError({ code, subcode: null, type: null, message: "limited", traceId: null, transient: false })).toBe("rate_limited");
    }
  });
});
