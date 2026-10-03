import { describe, expect, it } from "vitest";
import { mockProvider } from "./index";
import { mockSettingsSchema } from "./settings";
import type { PublishContext } from "../types";

const now = new Date("2026-10-03T12:00:00Z");
function ctx(settings: Record<string, unknown>, over: Partial<PublishContext> = {}): PublishContext {
  return {
    target: { id: "t1", scheduledAt: now, attempt: 1 },
    account: { id: "a1", externalId: "ext", displayName: "Mock", settings: mockSettingsSchema.parse(settings), credentials: null },
    content: { text: "hello", media: [] },
    postType: "text",
    state: null,
    now,
    signal: new AbortController().signal,
    ...over,
  };
}
const parse = (s: Record<string, unknown>) => mockSettingsSchema.parse(s);

describe("mock provider", () => {
  it("succeed → done with a mock id and url, plus a summary", async () => {
    const r = await mockProvider.advance(ctx({}));
    expect(r.kind).toBe("done");
    if (r.kind === "done") {
      expect(r.externalId).toMatch(/^mock-/);
      expect(r.url).toBe(`https://mock.invalid/${r.externalId}`);
    }
    expect(r.summary).toEqual({
      request: { step: "publish", attempt: 1, textLength: 5 },
      response: { behaviour: "succeed" },
    });
  });

  it("multi_step continues `steps` times, then publishes", async () => {
    const settings = { behaviour: "multi_step", steps: 2 };
    const s = parse(settings);
    expect(mockProvider.stepFor(null, s)).toEqual({ name: "create_container", mayPublish: false });
    const r1 = await mockProvider.advance(ctx(settings));
    expect(r1).toMatchObject({ kind: "continue", state: { done: 1 } });
    expect(mockProvider.stepFor({ done: 1 }, s)).toEqual({ name: "create_container", mayPublish: false });
    const r2 = await mockProvider.advance(ctx(settings, { state: { done: 1 } }));
    expect(r2).toMatchObject({ kind: "continue", state: { done: 2 } });
    expect(mockProvider.stepFor({ done: 2 }, s)).toEqual({ name: "publish", mayPublish: true });
    expect((await mockProvider.advance(ctx(settings, { state: { done: 2 } }))).kind).toBe("done");
  });

  it("non-multi_step behaviours start with a publishing step", () => {
    expect(mockProvider.stepFor(null, parse({}))).toEqual({ name: "publish", mayPublish: true });
  });

  it("retryable fails the first failTimes attempts, then succeeds; always when omitted", async () => {
    const s = { behaviour: "retryable", failTimes: 2 };
    expect((await mockProvider.advance(ctx(s, { target: { id: "t", scheduledAt: now, attempt: 2 } }))).kind).toBe("retryable_error");
    expect((await mockProvider.advance(ctx(s, { target: { id: "t", scheduledAt: now, attempt: 3 } }))).kind).toBe("done");
    expect((await mockProvider.advance(ctx({ behaviour: "retryable" }, { target: { id: "t", scheduledAt: now, attempt: 50 } }))).kind).toBe("retryable_error");
  });

  it("fatal / ambiguous map to their kinds", async () => {
    expect((await mockProvider.advance(ctx({ behaviour: "fatal" }))).kind).toBe("fatal_error");
    expect((await mockProvider.advance(ctx({ behaviour: "ambiguous" }))).kind).toBe("ambiguous");
  });

  it("rate_limited is retryable with notBefore = now + retryAfterSeconds", async () => {
    const r = await mockProvider.advance(ctx({ behaviour: "rate_limited", retryAfterSeconds: 120 }));
    expect(r).toMatchObject({ kind: "retryable_error", notBefore: new Date(now.getTime() + 120_000) });
  });

  it("throw throws", async () => {
    await expect(mockProvider.advance(ctx({ behaviour: "throw" }))).rejects.toThrow("mock provider threw");
  });

  it("delayMs honours the abort signal", async () => {
    const ac = new AbortController();
    const p = mockProvider.advance(ctx({ delayMs: 30000 }, { signal: ac.signal }));
    ac.abort(new Error("timeout"));
    await expect(p).rejects.toThrow("timeout");
  });

  it("delayMs waits then succeeds", async () => {
    const r = await mockProvider.advance(ctx({ delayMs: 10 }));
    expect(r.kind).toBe("done");
  });

  it("refreshCredentials succeeds with a new token expiring in 60 days, or fails", async () => {
    const base = { account: { id: "a", externalId: "e", settings: parse({}) }, credentials: {}, now, signal: new AbortController().signal };
    const ok = await mockProvider.refreshCredentials!(base);
    expect(ok).toMatchObject({ ok: true, expiresAt: new Date(now.getTime() + 60 * 86_400_000) });
    const bad = await mockProvider.refreshCredentials!({ ...base, account: { ...base.account, settings: parse({ refresh: "fail" }) } });
    expect(bad).toEqual({ ok: false, reason: "Mock refresh failure" });
  });

  it("validates against its own capabilities", () => {
    const issues = mockProvider.validate({ text: "x".repeat(501), media: [] }, mockProvider.capabilities);
    expect(issues.map((i) => i.code)).toEqual(["text_too_long"]);
  });

  it("settings defaults", () => {
    expect(parse({})).toMatchObject({ behaviour: "succeed", steps: 1, retryAfterSeconds: 300, delayMs: 0, refresh: "succeed" });
  });
});
