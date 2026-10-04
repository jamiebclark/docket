import { describe, expect, it } from "vitest";
import { classifyGraphError, graphStepError, graphSummary, scrub } from "./errors";
import type { GraphError, GraphOutcome } from "./graph";

const err = (over: Partial<GraphError>): GraphError => ({
  code: null,
  subcode: null,
  type: null,
  message: "boom",
  traceId: null,
  transient: false,
  ...over,
});
const graph = (e: Partial<GraphError>, status = 400): GraphOutcome => ({ kind: "graph_error", status, error: err(e) });
const opts = (mayPublish: boolean) => ({ mayPublish, platform: "Facebook", secrets: ["tok-secret-1"] });

describe("classifyGraphError", () => {
  it("treats 190 with any subcode as an invalid token", () => {
    expect(classifyGraphError(err({ code: 190 }))).toBe("invalid_token");
    expect(classifyGraphError(err({ code: 190, subcode: 463 }))).toBe("invalid_token");
  });
  it.each([4, 17, 32, 613])("rate-limit code %i", (code) => {
    expect(classifyGraphError(err({ code }))).toBe("rate_limited");
  });
  it.each([1, 2])("temporary code %i", (code) => {
    expect(classifyGraphError(err({ code }))).toBe("temporary");
  });
  it("treats is_transient as temporary and anything else as rejected", () => {
    expect(classifyGraphError(err({ code: 99, transient: true }))).toBe("temporary");
    expect(classifyGraphError(err({ code: 100 }))).toBe("rejected");
    expect(classifyGraphError(err({}))).toBe("rejected");
  });
});

describe("graphStepError", () => {
  it("returns null for ok", () => {
    expect(graphStepError({ kind: "ok", status: 200, body: {} }, opts(true))).toBeNull();
  });
  it("flags credentialsInvalid on 190", () => {
    const r = graphStepError(graph({ code: 190, subcode: 463 }, 401), opts(true));
    expect(r).toMatchObject({ kind: "fatal_error", credentialsInvalid: true });
    expect(r?.kind === "fatal_error" && r.error).toBe("Facebook says the access token is no longer valid (code 190/463).");
  });
  it("retries rate limits even on publish steps", () => {
    expect(graphStepError(graph({ code: 4 }), opts(true))?.kind).toBe("retryable_error");
  });
  it("makes temporary, 5xx, unparseable and after-send failures ambiguous on publish steps only", () => {
    const cases: GraphOutcome[] = [
      graph({ code: 2 }, 500),
      { kind: "http_error", status: 502 },
      { kind: "unparseable", status: 200 },
      { kind: "network", phase: "after_send" },
    ];
    for (const c of cases) {
      expect(graphStepError(c, opts(true))?.kind).toBe("ambiguous");
      expect(graphStepError(c, opts(false))?.kind).toBe("retryable_error");
    }
  });
  it("retries a pre-send failure on a publish step", () => {
    expect(graphStepError({ kind: "network", phase: "before_send" }, opts(true))?.kind).toBe("retryable_error");
  });
  it("treats validation errors and 4xx as fatal and scrubs secrets", () => {
    const r = graphStepError(graph({ code: 100, message: "bad access_token=tok-secret-1&x tok-secret-1" }), opts(true));
    expect(r?.kind).toBe("fatal_error");
    expect(JSON.stringify(r)).not.toContain("tok-secret-1");
    expect(graphStepError({ kind: "http_error", status: 403 }, opts(true))?.kind).toBe("fatal_error");
  });
});

describe("graphSummary and scrub", () => {
  it("summarises without the message", () => {
    expect(graphSummary(graph({ code: 100, subcode: 1, type: "OAuthException", traceId: "T", message: "secret" }))).toEqual({
      httpStatus: 400,
      graphCode: 100,
      graphSubcode: 1,
      graphType: "OAuthException",
      traceId: "T",
    });
    expect(graphSummary({ kind: "network", phase: "after_send" })).toEqual({});
  });
  it("caps length and redacts parameters", () => {
    expect(scrub("code=abc&client_secret=zzz", [])).toBe("code=[redacted]&client_secret=[redacted]");
    expect(scrub("x".repeat(600), []).length).toBe(500);
  });
});
