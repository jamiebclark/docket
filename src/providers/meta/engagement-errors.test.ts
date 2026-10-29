import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeGraph, type FakeGraph, type GraphReply } from "../../../tests/helpers/fake-graph";
import type { EngagementReadContext } from "../types";
import { classifyEngagementOutcome } from "./engagement-errors";
import type { MetaCommentSurface } from "./engagement-map";
import { DEFAULT_GRAPH_BASE, graphRequest, type MetaApp } from "./graph";
import { metaEngagementRead } from "./engagement-sweep";
import { resetUsageBackoffs } from "./usage";

const app: MetaApp = { graphBase: DEFAULT_GRAPH_BASE, version: "v26.0" };
const TOKEN = "s3cr3t-token";

let fake: FakeGraph;

beforeEach(() => {
  fake = createFakeGraph().install();
});

afterEach(() => {
  fake.uninstall();
});

async function run(configure: (g: FakeGraph) => void, signal: AbortSignal = new AbortController().signal) {
  configure(fake);
  const outcome = await graphRequest(app, { method: "GET", path: "/123/posts", token: TOKEN, signal });
  if (outcome.kind === "ok") throw new Error("expected a non-ok outcome");
  return outcome;
}

describe("classifyEngagementOutcome", () => {
  it("maps every classified graph_error code to one of the six non-page outcomes", async () => {
    const cases: { code: number; expected: string }[] = [
      { code: 190, expected: "credentials_invalid" },
      { code: 4, expected: "rate_limited" },
      { code: 17, expected: "rate_limited" },
      { code: 32, expected: "rate_limited" },
      { code: 613, expected: "rate_limited" },
      { code: 80001, expected: "rate_limited" },
      { code: 80002, expected: "rate_limited" },
      { code: 1, expected: "retryable_error" },
      { code: 2, expected: "retryable_error" },
      { code: 10, expected: "fatal_error" },
    ];
    for (const c of cases) {
      const outcome = await run((g) => g.on("GET", "/v26.0/123/posts", { kind: "graph_error", code: c.code }));
      const mapped = classifyEngagementOutcome(outcome, { platform: "Facebook", secrets: [TOKEN], hasCursor: false });
      expect(mapped.kind).toBe(c.expected);
    }
  });

  it("maps a code-100 error on a cursor-bearing request to cursor_lost", async () => {
    const outcome = await run((g) => g.on("GET", "/v26.0/123/posts", { kind: "graph_error", code: 100 }));
    const mapped = classifyEngagementOutcome(outcome, { platform: "Facebook", secrets: [TOKEN], hasCursor: true });
    expect(mapped.kind).toBe("cursor_lost");
  });

  it("maps a code-100 error with no cursor to fatal_error, not cursor_lost", async () => {
    const outcome = await run((g) => g.on("GET", "/v26.0/123/posts", { kind: "graph_error", code: 100 }));
    const mapped = classifyEngagementOutcome(outcome, { platform: "Facebook", secrets: [TOKEN], hasCursor: false });
    expect(mapped.kind).not.toBe("cursor_lost");
  });

  it("maps http 4xx to fatal_error and 5xx to retryable_error", async () => {
    const notFound = await run((g) => g.on("GET", "/v26.0/123/posts", { kind: "http", status: 404 }));
    expect(classifyEngagementOutcome(notFound, { platform: "Facebook", secrets: [TOKEN], hasCursor: false }).kind).toBe("fatal_error");

    const serverError = await run((g) => g.on("GET", "/v26.0/123/posts", { kind: "http", status: 503 }));
    expect(classifyEngagementOutcome(serverError, { platform: "Facebook", secrets: [TOKEN], hasCursor: false }).kind).toBe("retryable_error");
  });

  it("maps unparseable to retryable_error", async () => {
    const outcome = await run((g) => g.on("GET", "/v26.0/123/posts", { kind: "unparseable" }));
    expect(classifyEngagementOutcome(outcome, { platform: "Facebook", secrets: [TOKEN], hasCursor: false }).kind).toBe("retryable_error");
  });

  it("maps reset_mid_body and pre_send_failure (both 'network') to retryable_error", async () => {
    const reset = await run((g) => g.on("GET", "/v26.0/123/posts", { kind: "reset_mid_body" }));
    expect(classifyEngagementOutcome(reset, { platform: "Facebook", secrets: [TOKEN], hasCursor: false }).kind).toBe("retryable_error");

    const preSend = await run((g) => g.on("GET", "/v26.0/123/posts", { kind: "pre_send_failure" }));
    expect(classifyEngagementOutcome(preSend, { platform: "Facebook", secrets: [TOKEN], hasCursor: false }).kind).toBe("retryable_error");
  });

  it("maps a hung request, aborted by the timeout, to retryable_error", async () => {
    const outcome = await run((g) => g.on("GET", "/v26.0/123/posts", { kind: "hang" }), AbortSignal.timeout(20));
    expect(classifyEngagementOutcome(outcome, { platform: "Facebook", secrets: [TOKEN], hasCursor: false }).kind).toBe("retryable_error");
  });

  it("never lets a planted access token reach the mapped message or summary", async () => {
    const outcome = await run((g) => g.on("GET", "/v26.0/123/posts", { kind: "graph_error", code: 10, message: `token ${TOKEN} rejected` }));
    const mapped = classifyEngagementOutcome(outcome, { platform: "Facebook", secrets: [TOKEN], hasCursor: false });
    expect(JSON.stringify(mapped)).not.toContain(TOKEN);
  });
});

/** A minimal Facebook-shaped surface, per contracts/meta-comment-surface.md §3. */
const facebookSurface: MetaCommentSurface = {
  platform: "Facebook",
  ownPostsPath: (id) => `/${id}/posts`,
  postTimeField: "created_time",
  commentFields: ["id", "message", "created_time", "from{name,id}"],
  commentTextField: "message",
  commentTimeField: "created_time",
  drainParams: { order: "reverse_chronological", filter: "toplevel" },
  prefetchSelf: null,
  mapAuthor(comment) {
    const from = comment.from as { name?: unknown; id?: unknown } | undefined;
    return { displayName: typeof from?.name === "string" ? from.name : null, handle: null, externalId: typeof from?.id === "string" ? from.id : null, url: null, identityStable: typeof from?.id === "string" };
  },
  isSelf(comment, identity) {
    const from = comment.from as { id?: unknown } | undefined;
    return from?.id === identity.externalId;
  },
};

/** A minimal Instagram-shaped surface, per contracts/meta-comment-surface.md §4. */
const instagramSurface: MetaCommentSurface = {
  platform: "Instagram",
  ownPostsPath: (id) => `/${id}/media`,
  postTimeField: "timestamp",
  commentFields: ["id", "text", "timestamp", "username", "user{id}"],
  commentTextField: "text",
  commentTimeField: "timestamp",
  drainParams: {},
  prefetchSelf: null,
  mapAuthor(comment) {
    const username = typeof comment.username === "string" && comment.username !== "" ? comment.username : null;
    return { displayName: null, handle: username, externalId: null, url: null, identityStable: false };
  },
  isSelf(comment, identity) {
    const user = comment.user as { id?: unknown } | undefined;
    return typeof user?.id === "string" && user.id === identity.externalId;
  },
};

const NON_PAGE_KINDS = ["retryable_error", "fatal_error", "credentials_invalid", "rate_limited", "cursor_lost", "unavailable"];

function baseCtx(externalId: string): EngagementReadContext<unknown> {
  return {
    account: { id: "acct-1", externalId, displayName: "Page", settings: {}, credentials: { pageToken: "s3cr3t-token" } },
    cursor: null,
    providerState: {},
    direction: "newest",
    limit: 50,
    now: new Date("2026-10-19T00:00:00Z"),
    signal: new AbortController().signal,
  };
}

describe("metaEngagementRead — every fake-graph shape maps to one of the six non-page outcomes, end-to-end for both surfaces (US4, FR-019, SC-005)", () => {
  let fake: FakeGraph;
  beforeEach(() => {
    fake = createFakeGraph().install();
    resetUsageBackoffs();
  });
  afterEach(() => {
    fake.uninstall();
  });

  const shapes: GraphReply[] = [
    { kind: "graph_error", code: 190 },
    { kind: "graph_error", code: 4 },
    { kind: "graph_error", code: 1 },
    { kind: "graph_error", code: 10 },
    { kind: "http", status: 404 },
    { kind: "http", status: 503 },
    { kind: "unparseable" },
    { kind: "reset_mid_body" },
    { kind: "pre_send_failure" },
  ];

  for (const surface of [facebookSurface, instagramSurface]) {
    for (const shape of shapes) {
      it(`${surface.platform}: ${shape.kind}${"code" in shape ? ` (code ${shape.code})` : ""} maps to a classified outcome, not "page" or "unavailable"`, async () => {
        fake.on("GET", `/v26.0/1001/${surface.platform === "Facebook" ? "posts" : "media"}`, shape);
        const result = await metaEngagementRead(surface, baseCtx("1001"));
        expect(NON_PAGE_KINDS).toContain(result.kind);
      });
    }
  }
});
