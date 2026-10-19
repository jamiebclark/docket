import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeGraph } from "../../../tests/helpers/fake-graph";
import { threadsConnectGroup } from "./connect-group";

const ORIGINAL = { id: process.env.THREADS_APP_ID, secret: process.env.THREADS_APP_SECRET };
const fake = createFakeGraph();

beforeEach(() => {
  process.env.THREADS_APP_ID = "12345";
  process.env.THREADS_APP_SECRET = "s3cr3t-app-secret-value";
  fake.reset();
  fake.install();
});
afterEach(() => {
  if (ORIGINAL.id === undefined) delete process.env.THREADS_APP_ID;
  else process.env.THREADS_APP_ID = ORIGINAL.id;
  if (ORIGINAL.secret === undefined) delete process.env.THREADS_APP_SECRET;
  else process.env.THREADS_APP_SECRET = ORIGINAL.secret;
  fake.uninstall();
});

describe("threadsConnectGroup.exchangeCode", () => {
  const run = () =>
    threadsConnectGroup.exchangeCode({
      code: "CODE1234",
      redirectUri: "https://docket.local:3000/connect/callback",
      state: "st",
      now: new Date(),
      signal: new AbortController().signal,
    });
  const scriptHappyPath = (permissions: string | undefined) => {
    fake.on("POST", "/oauth/access_token", {
      kind: "ok",
      body: { access_token: "short", ...(permissions !== undefined ? { permissions } : {}) },
    });
    fake.on("GET", "/access_token", { kind: "ok", body: { access_token: "long", expires_in: 5184000 } });
    fake.on("GET", "/v1.0/me", { kind: "ok", body: { id: "17841", username: "acme" } });
  };

  it("attaches the already-parsed grantedList as grantedScopes (US2-AS2)", async () => {
    scriptHappyPath("threads_basic,threads_content_publish");
    const r = await run();
    expect(r.ok && r.candidates[0]?.grantedScopes).toEqual(["threads_basic", "threads_content_publish"]);
    expect(r.ok && r.candidates[0]?.notes).toBeUndefined();
  });

  it("leaves grantedScopes absent, not [] and not the requested list, when the reply has no permission list (US2-AS2)", async () => {
    scriptHappyPath(undefined);
    const r = await run();
    expect(r.ok && r.candidates[0]?.grantedScopes).toBeUndefined();
    expect(r.ok && r.candidates[0]?.notes).toBeUndefined();
  });

  it("keeps the missing-publish-permission note byte-identical when publish was not granted (FR-013)", async () => {
    scriptHappyPath("threads_basic");
    const r = await run();
    expect(r.ok && r.candidates[0]?.grantedScopes).toEqual(["threads_basic"]);
    expect(r.ok && r.candidates[0]?.notes).toEqual(["Publishing permission was not granted. Connect again and allow it."]);
  });
});

// FR-018, FR-029, US1-AS1, US2-AS1: with both engagement flags unset (they don't exist yet —
// Phase 6 adds them) and THREADS_INSIGHTS_SCOPES unset, the authorization URL is byte-identical to
// today's — compared against a literal, never a re-computation.
describe("threadsConnectGroup.authorizationUrl", () => {
  it("with both engagement flags and THREADS_INSIGHTS_SCOPES unset, the URL is byte-identical to today's", () => {
    const url = threadsConnectGroup.authorizationUrl({ state: "st", redirectUri: "https://x.test/connect/callback" });
    expect(url).toBe(
      "https://threads.com/oauth/authorize?client_id=12345&redirect_uri=https%3A%2F%2Fx.test%2Fconnect%2Fcallback&scope=threads_basic%2Cthreads_content_publish&response_type=code&state=st",
    );
  });

  // FR-018, FR-020, US3-AS1: flag on carries threads_manage_insights in addition to today's scopes.
  it("with THREADS_INSIGHTS_SCOPES=true, the dialog carries threads_manage_insights in addition to today's scopes", () => {
    process.env.THREADS_INSIGHTS_SCOPES = "true";
    try {
      const url = new URL(threadsConnectGroup.authorizationUrl({ state: "st", redirectUri: "https://x.test/connect/callback" }));
      expect(url.searchParams.get("scope")).toBe("threads_basic,threads_content_publish,threads_manage_insights");
    } finally {
      delete process.env.THREADS_INSIGHTS_SCOPES;
    }
  });

  it("with THREADS_ENGAGEMENT_SCOPES=true, the dialog carries threads_manage_replies and threads_manage_mentions in addition to today's scopes", () => {
    process.env.THREADS_ENGAGEMENT_SCOPES = "true";
    try {
      const url = new URL(threadsConnectGroup.authorizationUrl({ state: "st", redirectUri: "https://x.test/connect/callback" }));
      expect(url.searchParams.get("scope")).toBe(
        "threads_basic,threads_content_publish,threads_manage_replies,threads_manage_mentions",
      );
    } finally {
      delete process.env.THREADS_ENGAGEMENT_SCOPES;
    }
  });

  it("with both flags on, the dialog carries the full union in insights-then-engagement order", () => {
    process.env.THREADS_INSIGHTS_SCOPES = "true";
    process.env.THREADS_ENGAGEMENT_SCOPES = "true";
    try {
      const url = new URL(threadsConnectGroup.authorizationUrl({ state: "st", redirectUri: "https://x.test/connect/callback" }));
      expect(url.searchParams.get("scope")).toBe(
        "threads_basic,threads_content_publish,threads_manage_insights,threads_manage_replies,threads_manage_mentions",
      );
    } finally {
      delete process.env.THREADS_INSIGHTS_SCOPES;
      delete process.env.THREADS_ENGAGEMENT_SCOPES;
    }
  });
});

describe("threadsConnectGroup.optionalScopes", () => {
  it("declares threads_manage_insights, threads_manage_replies and threads_manage_mentions, and has no cannotWiden", () => {
    expect(threadsConnectGroup.optionalScopes?.declared).toEqual([
      { scope: "threads_manage_insights", purpose: "Read a Threads account's and its posts' numbers" },
      { scope: "threads_manage_replies", purpose: "Read replies to a Threads post" },
      { scope: "threads_manage_mentions", purpose: "Read mentions of a Threads account" },
    ]);
    expect(threadsConnectGroup.optionalScopes?.cannotWiden).toBeUndefined();
  });

  it("requests nothing when both flags are off", () => {
    expect(threadsConnectGroup.optionalScopes?.requested({ THREADS_APP_ID: "12345", THREADS_APP_SECRET: "a".repeat(32) })).toEqual([]);
  });

  it("requests threads_manage_insights when the insights flag is on (FR-018, FR-020)", () => {
    const requested = threadsConnectGroup.optionalScopes?.requested({
      THREADS_APP_ID: "12345",
      THREADS_APP_SECRET: "a".repeat(32),
      THREADS_INSIGHTS_SCOPES: "true",
    });
    expect(requested).toEqual(["threads_manage_insights"]);
  });

  it("requests threads_manage_replies and threads_manage_mentions when the engagement flag is on", () => {
    const requested = threadsConnectGroup.optionalScopes?.requested({
      THREADS_APP_ID: "12345",
      THREADS_APP_SECRET: "a".repeat(32),
      THREADS_ENGAGEMENT_SCOPES: "true",
    });
    expect(requested).toEqual(["threads_manage_replies", "threads_manage_mentions"]);
  });

  it("requests the union, in insights-then-engagement order, when both flags are on", () => {
    const requested = threadsConnectGroup.optionalScopes?.requested({
      THREADS_APP_ID: "12345",
      THREADS_APP_SECRET: "a".repeat(32),
      THREADS_INSIGHTS_SCOPES: "true",
      THREADS_ENGAGEMENT_SCOPES: "true",
    });
    expect(requested).toEqual(["threads_manage_insights", "threads_manage_replies", "threads_manage_mentions"]);
  });
});
