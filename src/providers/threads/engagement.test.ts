import { describe, expect, it } from "vitest";
import { threadsEngagement } from "./engagement";

const FORBIDDEN_WORDS = ["reconnect", "grant", "permission needed", "opt in", "enable"];

describe("threadsEngagement declaration", () => {
  it("reads is exactly reply and mention", () => {
    expect(threadsEngagement.declaration.reads).toEqual(["reply", "mention"]);
  });

  it("canReply is false", () => {
    expect(threadsEngagement.declaration.canReply).toBe(false);
  });

  it("has no readScopes, missingReadScopes or writeBudget key", () => {
    expect(threadsEngagement.declaration).not.toHaveProperty("readScopes");
    expect(threadsEngagement.declaration).not.toHaveProperty("missingReadScopes");
    expect(threadsEngagement.declaration).not.toHaveProperty("writeBudget");
  });

  it("unavailable.reason contains none of the forbidden words", () => {
    const reason = threadsEngagement.declaration.unavailable?.reason.toLowerCase() ?? "";
    for (const word of FORBIDDEN_WORDS) expect(reason).not.toContain(word);
  });
});

describe("threadsEngagement.read", () => {
  it("returns kind: unavailable and never reads ctx", async () => {
    const ctx = new Proxy(
      {},
      {
        get() {
          throw new Error("read() must not touch ctx");
        },
      },
    );
    const result = await threadsEngagement.read(ctx as never);
    expect(result.kind).toBe("unavailable");
  });
});

describe("threadsEngagement.send", () => {
  it("returns kind: fatal_error with no flagAccount and never reads ctx", async () => {
    const ctx = new Proxy(
      {},
      {
        get() {
          throw new Error("send() must not touch ctx");
        },
      },
    );
    const result = await threadsEngagement.send(ctx as never);
    expect(result.kind).toBe("fatal_error");
    expect(result).not.toHaveProperty("flagAccount");
  });
});
