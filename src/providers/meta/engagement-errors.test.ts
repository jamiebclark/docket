import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeGraph, type FakeGraph } from "../../../tests/helpers/fake-graph";
import { classifyEngagementOutcome } from "./engagement-errors";
import { DEFAULT_GRAPH_BASE, graphRequest, type MetaApp } from "./graph";

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
