import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishContext } from "../types";
import { advanceTikTok } from "./publish";
import { sealUploadUrl } from "./sealed";
import { creatorReply, createFakeTikTok } from "../../../tests/helpers/fake-tiktok";

const SECRET = "client-secret";
const UPLOAD = "https://upload.tiktok.test/v/abc?upload_id=1&sig=SIG";
const VIDEO_URL = "https://media.test/v.mp4";
const BYTES = 20_000_000;
const now = new Date("2026-01-01T12:00:00.000Z");
const credentials = {
  v: 1, accessToken: "ACCESS", refreshToken: "REFRESH", accessExpiresAt: now.getTime() + 3_600_000,
  refreshIssuedAt: now.getTime(), refreshExpiresAt: now.getTime() + 86_400_000, refreshExpiryEstimated: false, openId: "o",
};
const values = { v: 1, privacy: "FOLLOWER_OF_CREATOR", allowComments: true, allowDuets: false, allowStitches: false };
const tiktok = createFakeTikTok();
const ranges: string[] = [];

function ctx(step: string, state: unknown, over: Partial<PublishContext> = {}): PublishContext {
  return {
    target: { id: "t1", scheduledAt: now, attempt: 1 },
    account: { id: "a1", externalId: "o", displayName: "Ada", settings: {}, credentials },
    content: {
      text: "hello",
      media: [{ kind: "video", url: VIDEO_URL, bytes: BYTES, mimeType: "video/mp4", video: { durationSeconds: 10 } } as never],
      posting: { values, details: null },
    },
    postType: "video",
    step: { name: step, mayPublish: false },
    state,
    now,
    signal: new AbortController().signal,
    ...over,
  };
}

const chunksState = (sent: number, extra: Record<string, unknown> = {}) => ({
  v: 1, kind: "video", phase: "chunks", restarts: 0, nickname: "Ada", fileUrl: VIDEO_URL, fileBytes: BYTES, chunkSize: 5_242_880,
  chunkCount: 3, chunksSent: sent, publishId: "pub1", sealedUploadUrl: sealUploadUrl(UPLOAD, SECRET, "t1:pub1"),
  uploadIssuedAt: now.toISOString(), ...extra,
});

beforeEach(() => {
  vi.stubEnv("TIKTOK_CLIENT_KEY", "key");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", SECRET);
  vi.stubEnv("TIKTOK_APP_AUDITED", "true");
  tiktok.reset();
  tiktok.install();
  const inner = globalThis.fetch;
  ranges.length = 0;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === VIDEO_URL) {
      const m = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get("range") ?? "")!;
      const [a, b] = [Number(m[1]), Number(m[2])];
      ranges.push(`${a}-${b}`);
      return new Response(new Uint8Array(b - a + 1), { status: 206, headers: { "content-range": `bytes ${a}-${b}/${BYTES}` } });
    }
    return inner(input as never, init);
  });
});
afterEach(() => {
  tiktok.uninstall();
  vi.unstubAllEnvs();
});

describe("advanceTikTok video", () => {
  it("check_creator continues to start", async () => {
    tiktok.on("POST", "/v2/post/publish/creator_info/query/", { kind: "ok", body: creatorReply({ privacy_level_options: ["FOLLOWER_OF_CREATOR", "SELF_ONLY"] }) });
    const r = await advanceTikTok(ctx("check_creator", null));
    expect(r, JSON.stringify(r)).toMatchObject({ kind: "continue", state: { phase: "start", kind: "video" } });
  });

  it("check_creator fails when the privacy level is gone", async () => {
    tiktok.on("POST", "/v2/post/publish/creator_info/query/", { kind: "ok", body: creatorReply({ privacy_level_options: ["SELF_ONLY"] }) });
    const r = await advanceTikTok(ctx("check_creator", null));
    expect(r).toMatchObject({ kind: "fatal_error" });
    expect((r as { error: string }).error).toContain("Followers");
  });

  it("the posting cap waits an hour, then gives up at 23 hours", async () => {
    tiktok.on("POST", "/v2/post/publish/creator_info/query/", { kind: "error", code: "spam_risk_too_many_posts" });
    const first = await advanceTikTok(ctx("check_creator", null));
    expect(first).toMatchObject({ kind: "continue", notBefore: new Date(now.getTime() + 3_600_000) });
    const state = (first as { state: Record<string, unknown> }).state;
    const later = new Date(now.getTime() + 23 * 3_600_000);
    expect((await advanceTikTok(ctx("check_creator", state, { now: later }))).kind).toBe("fatal_error");
  });

  it("start_upload sends post_info and source_info and seals the address", async () => {
    tiktok.on("POST", "/v2/post/publish/video/init/", { kind: "ok", body: { data: { publish_id: "pub1", upload_url: UPLOAD }, error: { code: "ok" } } });
    const start = { v: 1, kind: "video", phase: "start", restarts: 0, nickname: "Ada" };
    const r = await advanceTikTok(ctx("start_upload", start));
    const req = tiktok.callsTo("POST", "/v2/post/publish/video/init/")[0]!;
    expect(req.fields.source_info).toEqual({ source: "FILE_UPLOAD", video_size: BYTES, chunk_size: 5_242_880, total_chunk_count: 3 });
    expect(req.fields.post_info).toMatchObject({ privacy_level: "FOLLOWER_OF_CREATOR", title: "hello", disable_comment: false });
    expect(r).toMatchObject({ kind: "continue", state: { phase: "chunks", chunksSent: 0, publishId: "pub1" } });
    expect(JSON.stringify(r)).not.toContain("upload.tiktok.test");
  });

  it("uploads one chunk per step by byte range with Content-Range", async () => {
    tiktok.on("PUT", "/v/abc", [{ kind: "http", status: 206 }, { kind: "http", status: 206 }, { kind: "http", status: 201 }]);
    const one = await advanceTikTok(ctx("upload_chunk_1", chunksState(0)));
    expect(one).toMatchObject({ kind: "continue", state: { chunksSent: 1 } });
    await advanceTikTok(ctx("upload_chunk_2", chunksState(1)));
    const last = await advanceTikTok(ctx("upload_chunk_3", chunksState(2)));
    expect(ranges).toEqual(["0-5242879", "5242880-10485759", "10485760-19999999"]);
    expect(tiktok.callsTo("PUT", "/v/abc").map((r) => r.upload?.contentRange)).toEqual([
      "bytes 0-5242879/20000000", "bytes 5242880-10485759/20000000", "bytes 10485760-19999999/20000000",
    ]);
    expect(last).toMatchObject({ kind: "continue", state: { phase: "status" } });
    expect(tiktok.callsTo("POST", "/v2/post/publish/video/init/")).toHaveLength(0);
  });

  it("a 403 restarts from the creator check, at most twice", async () => {
    tiktok.on("PUT", "/v/abc", { kind: "http", status: 403 });
    expect(await advanceTikTok(ctx("upload_chunk_1", chunksState(0)))).toMatchObject({ kind: "continue", state: { phase: "creator", restarts: 1 } });
    expect((await advanceTikTok(ctx("upload_chunk_1", chunksState(0, { restarts: 2 })))).kind).toBe("fatal_error");
  });

  it("an address 55 minutes old restarts without a request", async () => {
    const old = chunksState(0, { uploadIssuedAt: new Date(now.getTime() - 55 * 60_000).toISOString() });
    expect(await advanceTikTok(ctx("upload_chunk_1", old))).toMatchObject({ kind: "continue", state: { restarts: 1 } });
    expect(tiktok.requests).toHaveLength(0);
  });

  it("an unsealable address restarts", async () => {
    const bad = chunksState(0, { sealedUploadUrl: "a.b.c" });
    expect(await advanceTikTok(ctx("upload_chunk_1", bad))).toMatchObject({ kind: "continue", state: { restarts: 1 } });
  });

  it("check_status finishes with the publish id", async () => {
    tiktok.on("POST", "/v2/post/publish/status/fetch/", { kind: "ok", body: { data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [1] }, error: { code: "ok" } } });
    const state = { v: 1, kind: "video", phase: "status", restarts: 0, nickname: "Ada", publishId: "pub1", sentAt: new Date(now.getTime() - 60_000).toISOString(), reads: 0 };
    expect(await advanceTikTok(ctx("check_status", state))).toMatchObject({ kind: "done", externalId: "pub1" });
  });

  it("check_status waits until the next read is due, and gives up ambiguous at the ceiling", async () => {
    const sentAt = new Date(now.getTime() - 5_000).toISOString();
    const state = { v: 1, kind: "video", phase: "status", restarts: 0, nickname: "Ada", publishId: "pub1", sentAt, reads: 0 };
    expect(await advanceTikTok(ctx("check_status", state))).toMatchObject({ kind: "continue" });
    expect(tiktok.requests).toHaveLength(0);
    tiktok.on("POST", "/v2/post/publish/status/fetch/", { kind: "ok", body: { data: { status: "PROCESSING_UPLOAD" }, error: { code: "ok" } } });
    const old = { ...state, sentAt: new Date(now.getTime() - 61 * 60_000).toISOString(), reads: 30 };
    expect((await advanceTikTok(ctx("check_status", old))).kind).toBe("ambiguous");
  });

  it("check_status maps a failed post to a plain fatal error", async () => {
    tiktok.on("POST", "/v2/post/publish/status/fetch/", { kind: "ok", body: { data: { status: "FAILED", fail_reason: "auth_removed" }, error: { code: "ok" } } });
    const state = { v: 1, kind: "video", phase: "status", restarts: 0, nickname: "Ada", publishId: "pub1", sentAt: new Date(now.getTime() - 60_000).toISOString(), reads: 0 };
    expect(await advanceTikTok(ctx("check_status", state))).toMatchObject({ kind: "fatal_error", credentialsInvalid: true });
  });
});

describe("advanceTikTok photo", () => {
  const PHOTO_INIT = "/v2/post/publish/content/init/";
  const urls = ["https://media.test/1.jpg", "https://media.test/2.jpg", "https://media.test/3.jpg"];
  const photoCtx = (over: Partial<PublishContext> = {}, postValues: Record<string, unknown> = values) =>
    ctx("publish_photos", { v: 1, kind: "photo", phase: "start", restarts: 0, nickname: "Ada" }, {
      postType: "image",
      content: {
        text: "caption text",
        media: urls.map((url) => ({ kind: "image", url, bytes: 1000, mimeType: "image/jpeg" }) as never),
        posting: { values: postValues, details: null },
      },
      step: { name: "publish_photos", mayPublish: true },
      ...over,
    });
  const accepted = { kind: "ok", body: { data: { publish_id: "p_pub_1" }, error: { code: "ok" } } } as const;

  it("sends PHOTO / DIRECT_POST with the https URLs in order and cover index 0", async () => {
    tiktok.on("POST", PHOTO_INIT, accepted);
    const r = await advanceTikTok(photoCtx({}, { ...values, photoTitle: "My title" }));
    expect(r, JSON.stringify(r)).toMatchObject({ kind: "continue", state: { kind: "photo", phase: "status", publishId: "p_pub_1" } });
    const [call] = tiktok.callsTo("POST", PHOTO_INIT);
    expect(call!.fields).toMatchObject({
      media_type: "PHOTO",
      post_mode: "DIRECT_POST",
      source_info: { source: "PULL_FROM_URL", photo_images: urls, photo_cover_index: 0 },
      post_info: { privacy_level: "FOLLOWER_OF_CREATOR", title: "My title", description: "caption text", disable_comment: false },
    });
  });

  it("a reply that never arrives after the request left is ambiguous, not retried", async () => {
    tiktok.on("POST", PHOTO_INIT, { kind: "network", phase: "lost" } as never);
    expect((await advanceTikTok(photoCtx())).kind).toBe("ambiguous");
  });

  it("a refusal such as url_ownership_unverified is fatal and says nothing was posted", async () => {
    tiktok.on("POST", PHOTO_INIT, { kind: "http", status: 400, body: JSON.stringify({ error: { code: "url_ownership_unverified", message: "no" } }) } as never);
    const r = await advanceTikTok(photoCtx());
    expect(r).toMatchObject({ kind: "fatal_error" });
    expect((r as { error: string }).error).toContain("Nothing was posted");
  });
});
