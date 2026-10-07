import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeX, rateLimited } from "../../../tests/helpers/fake-x";
import type { PublishContext, StepResult } from "../types";
import { advanceX } from "./publish";

const ACCESS = "ACCESS-TOKEN-SECRET";
const REFRESH = "REFRESH-TOKEN-SECRET";
const now = new Date("2026-01-01T00:00:00Z");
const TWEETS = "/2/tweets";
const fake = createFakeX();

beforeEach(() => {
  fake.reset();
  fake.secrets(ACCESS, REFRESH);
  fake.install();
});
afterEach(() => fake.uninstall());

function ctx(over: Partial<PublishContext> & { text?: string; username?: string | null } = {}): PublishContext {
  const { text, username, ...rest } = over;
  return {
    target: { id: "t1", scheduledAt: now, attempt: 1 },
    account: {
      id: "a1",
      externalId: "2244994945",
      displayName: "@dockettest",
      settings: username === null ? {} : { username: username ?? "dockettest" },
      credentials: { v: 1, accessToken: ACCESS, refreshToken: REFRESH, accessExpiresAt: now.getTime() + 3_600_000, refreshIssuedAt: now.getTime() },
    },
    content: { text: text ?? "hello world", media: [] },
    postType: "text",
    step: { name: "create_post", mayPublish: true },
    state: null,
    now,
    signal: new AbortController().signal,
    ...rest,
  } as PublishContext;
}

const noSecrets = (r: StepResult) => {
  const json = JSON.stringify(r);
  for (const s of [ACCESS, REFRESH]) expect(json).not.toContain(s);
};
const created = { kind: "ok", status: 201, body: { data: { id: "1445880548472328192", text: "hello world" } } } as const;

describe("advanceX create_post", () => {
  it("publishes text in one request and returns the post URL", async () => {
    fake.on("POST", TWEETS, created);
    const r = await advanceX(ctx());
    expect(r).toMatchObject({ kind: "done", externalId: "1445880548472328192", url: "https://x.com/dockettest/status/1445880548472328192" });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ method: "POST", host: "api.x.com", path: TWEETS, auth: "bearer", fields: { text: "hello world" } });
    expect(fake.requests[0]!.fields.media).toBeUndefined();
    expect(r.summary?.request).toMatchObject({ step: "create_post", images: 0, hasText: true, textUnits: 11 });
    noSecrets(r);
  });

  it("falls back to /i/status/ without a usable username", async () => {
    fake.on("POST", TWEETS, created);
    expect(await advanceX(ctx({ username: null }))).toMatchObject({ url: "https://x.com/i/status/1445880548472328192" });
  });

  it("keeps a numeric id a string", async () => {
    fake.on("POST", TWEETS, { kind: "ok", status: 201, body: { data: { id: "9007199254740993" } } });
    expect(await advanceX(ctx())).toMatchObject({ kind: "done", externalId: "9007199254740993" });
  });

  it.each([
    ["unparseable body", { kind: "unparseable" }],
    ["no id", { kind: "ok", status: 201, body: { data: {} } }],
    ["numeric id", { kind: "ok", status: 201, body: { data: { id: 123 } } }],
    ["empty body", { kind: "http", status: 200 }],
    ["lost mid body", { kind: "reset_mid_body" }],
    ["500", { kind: "problem", status: 500 }],
    ["503", { kind: "problem", status: 503 }],
  ] as const)("is ambiguous on %s", async (_n, reply) => {
    fake.on("POST", TWEETS, reply);
    const r = await advanceX(ctx());
    expect(r.kind).toBe("ambiguous");
    noSecrets(r);
  });

  it("is ambiguous when the connection is lost after sending (abort)", async () => {
    fake.on("POST", TWEETS, { kind: "hang" });
    const ac = new AbortController();
    const p = advanceX(ctx({ signal: ac.signal }));
    ac.abort();
    expect((await p).kind).toBe("ambiguous");
  });

  it("is retryable when nothing was sent", async () => {
    fake.on("POST", TWEETS, { kind: "pre_send_failure" });
    expect(await advanceX(ctx())).toMatchObject({ kind: "retryable_error", error: "Could not reach X; nothing was sent. Will retry." });
  });

  it("is retryable with credentialsExpired on 401, with or without a body", async () => {
    fake.on("POST", TWEETS, [{ kind: "problem", status: 401, title: "Unauthorized" }, { kind: "http", status: 401 }]);
    expect(await advanceX(ctx())).toMatchObject({ kind: "retryable_error", credentialsExpired: true });
    expect(await advanceX(ctx())).toMatchObject({ kind: "retryable_error", credentialsExpired: true });
  });

  it("is fatal on a duplicate 403, and on another 403 with X's detail", async () => {
    fake.on("POST", TWEETS, [
      { kind: "problem", status: 403, title: "Forbidden", detail: "You are not allowed to create a Tweet with duplicate content." },
      { kind: "problem", status: 403, title: "Forbidden", detail: "Your account is suspended." },
      { kind: "http", status: 403 },
    ]);
    expect(await advanceX(ctx())).toMatchObject({ kind: "fatal_error", error: "X refused this as a duplicate of a recent post." });
    expect(await advanceX(ctx())).toMatchObject({ kind: "fatal_error", error: "X refused the post: Your account is suspended." });
    expect(await advanceX(ctx())).toMatchObject({ kind: "fatal_error", error: "X refused the post: HTTP 403" });
  });

  it("is fatal on another 4xx", async () => {
    fake.on("POST", TWEETS, { kind: "problem", status: 400, title: "Invalid Request", detail: "bad text" });
    expect(await advanceX(ctx())).toMatchObject({ kind: "fatal_error", error: "X refused the post: bad text" });
  });

  it("waits for the reset when the window is exhausted", async () => {
    const reset = Math.floor(now.getTime() / 1000) + 600;
    fake.on("POST", TWEETS, { kind: "problem", status: 429, headers: rateLimited({ remaining: 0, reset }) });
    const r = await advanceX(ctx());
    expect(r).toMatchObject({ kind: "retryable_error", notBefore: new Date(reset * 1000) });
    expect(r.summary?.response).toMatchObject({ status: 429, rateLimitRemaining: 0, retryAfterSeconds: 600 });
  });

  it("treats a 429 with requests remaining as a usage cap: at least an hour", async () => {
    const reset = Math.floor(now.getTime() / 1000) + 60;
    fake.on("POST", TWEETS, [
      { kind: "problem", status: 429, headers: rateLimited({ remaining: 5, reset }) },
      { kind: "problem", status: 429 },
    ]);
    for (let i = 0; i < 2; i++) {
      const r = await advanceX(ctx());
      expect(r.kind).toBe("retryable_error");
      expect((r as { notBefore: Date }).notBefore.getTime()).toBeGreaterThanOrEqual(now.getTime() + 3_600_000);
      expect((r as { error: string }).error).toMatch(/usage cap/);
    }
  });

  it("sends no request when the credentials are unreadable", async () => {
    const c = ctx();
    const r = await advanceX({ ...c, account: { ...c.account, credentials: { v: 1 } } });
    expect(r).toMatchObject({ kind: "fatal_error" });
    expect(fake.requests).toHaveLength(0);
  });

  it("sends no request when the step no longer matches the content", async () => {
    const r = await advanceX(ctx({ step: { name: "upload_image_1", mayPublish: false } }));
    expect(r).toMatchObject({ kind: "retryable_error", error: "The post changed while publishing; will retry." });
    expect(fake.requests).toHaveLength(0);
  });

  it("never sends a secret or the one-shot or legacy media endpoints", async () => {
    fake.on("POST", TWEETS, { kind: "problem", status: 403, detail: `echo ${ACCESS}` });
    const r = await advanceX(ctx());
    noSecrets(r);
    expect(fake.requests.every((q) => q.path === TWEETS)).toBe(true);
  });
});

describe("advanceX image steps", () => {
  const INIT = "/2/media/upload/initialize";
  const APPEND = "/2/media/upload/9001/append";
  const FINALIZE = "/2/media/upload/9001/finalize";
  const STATUS = "/2/media/upload";
  const METADATA = "/2/media/metadata";
  const IMG_URL = "https://media.example.test/img.jpg";
  const media = (over: Partial<PublishContext["content"]["media"][number]> = {}) =>
    ({ url: IMG_URL, mimeType: "image/jpeg", width: 10, height: 10, bytes: 4, altText: "", ...over }) as PublishContext["content"]["media"][number];
  const image = (over = {}) => ({ mediaId: "9001", expiresAt: now.getTime() + 3_600_000, processing: "done", checks: 0, alt: false, described: false, ...over });
  const stateOf = (mediaCount: number, images: unknown[]) => ({ v: 1, mediaCount, images });

  /** Serves the image bytes; every other request goes to the fake. */
  function serveImage(status = 200) {
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) =>
      String(input) === IMG_URL ? new Response(status === 200 ? new Uint8Array([1, 2, 3, 4]) : "gone", { status }) : inner(input, init),
    );
  }
  const upload = (over: Partial<PublishContext> = {}) =>
    ctx({ content: { text: "hi", media: [media()] }, step: { name: "upload_image_1", mayPublish: false }, ...over });
  const script = () => {
    fake.on("POST", INIT, { kind: "ok", body: { data: { id: "9001", expires_after_secs: 86400 } } });
    fake.on("POST", APPEND, { kind: "ok", body: { data: { expires_at: 1 } } });
    fake.on("POST", FINALIZE, { kind: "ok", body: { data: { id: "9001", expires_after_secs: 600 } } });
  };

  it("uploads in three chunked calls and records the media id and expiry", async () => {
    script();
    serveImage();
    const r = await advanceX(upload());
    expect(r).toMatchObject({ kind: "continue", state: { v: 1, mediaCount: 1, images: [{ mediaId: "9001", processing: "done", alt: false, described: false, expiresAt: now.getTime() + 600_000 }] } });
    expect(fake.requests.map((q) => `${q.method} ${q.path}`)).toEqual([`POST ${INIT}`, `POST ${APPEND}`, `POST ${FINALIZE}`]);
    expect(fake.requests[0]!.fields).toMatchObject({ media_type: "image/jpeg", total_bytes: 4, media_category: "tweet_image" });
    expect(fake.requests[1]!.multipart).toMatchObject({ fields: ["media", "segment_index"], mediaBytes: 4, mediaType: "image/jpeg" });
    expect(fake.requests[1]!.fields).toMatchObject({ segment_index: "0" });
    expect(fake.requests.every((q) => q.auth === "bearer")).toBe(true);
    noSecrets(r);
  });

  it("marks a pending finalize and waits check_after_secs", async () => {
    fake.on("POST", INIT, { kind: "ok", body: { data: { id: "9001" } } });
    fake.on("POST", APPEND, { kind: "ok", body: {} });
    fake.on("POST", FINALIZE, { kind: "ok", body: { data: { id: "9001", processing_info: { state: "pending", check_after_secs: 7 } } } });
    serveImage();
    const r = await advanceX(upload({ content: { text: "hi", media: [media({ altText: "a cat" })] } }));
    expect(r).toMatchObject({ kind: "continue", state: { images: [{ processing: "pending", alt: true, expiresAt: now.getTime() + 3_600_000 }] } });
    expect((r as { notBefore: Date }).notBefore.getTime()).toBe(now.getTime() + 7000);
    expect(r.summary?.response).toMatchObject({ processingState: "pending" });
  });

  it("refuses a type or size X does not take before any request", async () => {
    serveImage();
    expect(await advanceX(upload({ content: { text: "hi", media: [media({ mimeType: "image/gif" })] } }))).toMatchObject({ kind: "fatal_error" });
    expect(await advanceX(upload({ content: { text: "hi", media: [media({ bytes: 5_000_001 })] } }))).toMatchObject({ kind: "fatal_error" });
    expect(fake.requests).toHaveLength(0);
  });

  it("retries when the image cannot be read, and on a 5xx; a 4xx is fatal", async () => {
    serveImage(404);
    expect(await advanceX(upload())).toMatchObject({ kind: "retryable_error" });
    fake.reset();
    fake.install();
    serveImage();
    fake.on("POST", INIT, { kind: "problem", status: 503, title: "Unavailable" });
    expect(await advanceX(upload())).toMatchObject({ kind: "retryable_error" });
    fake.on("POST", INIT, { kind: "problem", status: 400, detail: "bad media" });
    expect(await advanceX(upload())).toMatchObject({ kind: "fatal_error", error: expect.stringContaining("bad media") });
    fake.on("POST", INIT, { kind: "problem", status: 401, title: "Unauthorized" });
    expect(await advanceX(upload())).toMatchObject({ kind: "retryable_error", credentialsExpired: true });
  });

  it("polls STATUS: succeeded finishes, in_progress waits, failed is fatal, the 30th poll is fatal", async () => {
    const check = (images: unknown[]) => ctx({ content: { text: "hi", media: [media()] }, step: { name: "check_image_1", mayPublish: false }, state: stateOf(1, images) });
    fake.on("GET", `${STATUS}?command=STATUS`, [
      { kind: "ok", body: { data: { id: "9001", processing_info: { state: "in_progress", check_after_secs: 2 } } } },
      { kind: "ok", body: { data: { id: "9001", processing_info: { state: "succeeded" } } } },
      { kind: "ok", body: { data: { id: "9001", processing_info: { state: "failed" } } } },
    ]);
    const wait = await advanceX(check([image({ processing: "pending" })]));
    expect(wait).toMatchObject({ kind: "continue", state: { images: [{ processing: "pending", checks: 1 }] } });
    expect((wait as { notBefore: Date }).notBefore.getTime()).toBe(now.getTime() + 2000);
    expect(fake.requests[0]).toMatchObject({ method: "GET", query: { command: "STATUS", media_id: "9001" } });
    expect(await advanceX(check([image({ processing: "pending", checks: 1 })]))).toMatchObject({ kind: "continue", state: { images: [{ processing: "done" }] } });
    expect(await advanceX(check([image({ processing: "pending" })]))).toMatchObject({ kind: "fatal_error" });
    fake.on("GET", `${STATUS}?command=STATUS`, { kind: "ok", body: { data: { processing_info: { state: "pending" } } } });
    expect(await advanceX(check([image({ processing: "pending", checks: 29 })]))).toMatchObject({ kind: "fatal_error" });
  });

  it("describes only with alt text; an emptied alt text skips the request", async () => {
    const describe_ = (alt: string) =>
      ctx({ content: { text: "hi", media: [media({ altText: alt })] }, step: { name: "describe_image_1", mayPublish: false }, state: stateOf(1, [image({ alt: true })]) });
    fake.on("POST", METADATA, { kind: "ok", body: { data: { id: "9001" } } });
    const r = await advanceX(describe_("a cat"));
    expect(r).toMatchObject({ kind: "continue", state: { images: [{ described: true }] } });
    expect(fake.requests[0]).toMatchObject({ path: METADATA, fields: { id: "9001", metadata: { alt_text: { text: "a cat" } } } });
    fake.requests.length = 0;
    expect(await advanceX(describe_("  "))).toMatchObject({ kind: "continue", state: { images: [{ described: true }] } });
    expect(fake.requests).toHaveLength(0);
  });

  it("create_post sends media_ids in image order and omits empty text", async () => {
    fake.on("POST", TWEETS, created);
    const imgs = [image({ mediaId: "11" }), image({ mediaId: "22" })];
    const c = ctx({ text: "", content: { text: "", media: [media(), media()] }, state: stateOf(2, imgs) });
    expect(await advanceX(c)).toMatchObject({ kind: "done" });
    expect(fake.requests[0]!.fields).toEqual({ media: { media_ids: ["11", "22"] } });
  });

  it("create_post re-uploads from an image whose media id is about to expire, sending nothing", async () => {
    const imgs = [image({ mediaId: "11" }), image({ mediaId: "22", expiresAt: now.getTime() + 30_000 })];
    const r = await advanceX(ctx({ content: { text: "hi", media: [media(), media()] }, state: stateOf(2, imgs) }));
    expect(r).toMatchObject({ kind: "continue", state: { images: [{ mediaId: "11" }] } });
    expect(fake.requests).toHaveLength(0);
  });

  it("only ever calls the chunked media endpoints", async () => {
    script();
    serveImage();
    await advanceX(upload());
    for (const q of fake.requests) {
      expect(q.path).not.toBe("/2/media/upload");
      expect(q.query.command ?? "").not.toMatch(/INIT|APPEND|FINALIZE/);
    }
  });
});
