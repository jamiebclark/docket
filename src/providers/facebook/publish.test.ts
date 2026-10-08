import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docsUrl } from "@/lib/docs";
import { createFakeGraph, type FakeGraph } from "../../../tests/helpers/fake-graph";
import type { MediaItem, PublishContext } from "../types";
import { advanceFacebook } from "./publish";
import { facebookStepFor } from "./steps";

const PAGE = "1234567890";
const TOKEN = "EAAB-page-token-0123456789abcdef";
const now = new Date("2026-01-01T00:00:00Z");
const img = (n: number): MediaItem => ({ url: `https://media.test/${n}.jpg`, mimeType: "image/jpeg", width: 10, height: 10, bytes: 100, altText: "" });

let graph: FakeGraph;
beforeEach(() => {
  graph = createFakeGraph().install();
});
afterEach(() => graph.uninstall());

const vid = (n: number): MediaItem => ({ url: `https://media.test/${n}.mp4`, mimeType: "video/mp4", width: 1920, height: 1080, bytes: 1000, altText: "", kind: "video" });

function videoCtx(text: string): PublishContext {
  return {
    target: { id: "t1", scheduledAt: now, attempt: 1 },
    account: { id: "a1", externalId: PAGE, displayName: "Page", settings: {}, credentials: { pageToken: TOKEN } },
    content: { text, media: [vid(1)] },
    postType: "video",
    step: { name: "publish_video", mayPublish: true },
    state: null,
    now,
    signal: new AbortController().signal,
  };
}

function ctx(text: string, mediaCount: number, state: unknown = null, stepName?: string): PublishContext {
  const media = Array.from({ length: mediaCount }, (_, i) => img(i + 1));
  const step = stepName ? { name: stepName, mayPublish: !stepName.startsWith("upload_") } : facebookStepFor(state, { text, mediaCount });
  return {
    target: { id: "t1", scheduledAt: now, attempt: 1 },
    account: { id: "a1", externalId: PAGE, displayName: "Page", settings: {}, credentials: { pageToken: TOKEN } },
    content: { text, media },
    postType: mediaCount === 0 ? "text" : mediaCount === 1 ? "image" : "carousel",
    step,
    state,
    now,
    signal: new AbortController().signal,
  };
}

const feed = new RegExp(`/v[\\d.]+/${PAGE}/feed$`);
const photos = new RegExp(`/v[\\d.]+/${PAGE}/photos$`);

function paths() {
  return graph.requests.map((r) => r.path.replace(/^\/v[\d.]+/, ""));
}

describe("Facebook publish success paths", () => {
  it("publishes text only", async () => {
    graph.fallback({ kind: "ok", body: { id: `${PAGE}_99` } });
    const r = await advanceFacebook(ctx("hello", 0));
    expect(r).toMatchObject({ kind: "done", externalId: `${PAGE}_99` });
    expect(graph.requests).toHaveLength(1);
    expect(graph.requests[0]!.path).toMatch(feed);
    expect(graph.requests[0]!.params).toEqual({ message: "hello", access_token: "[redacted]" });
  });

  it("sends the first URL as link", async () => {
    graph.fallback({ kind: "ok", body: { id: "p_1" } });
    await advanceFacebook(ctx("read https://example.com/a. and https://b.test", 0));
    expect(graph.requests[0]!.params).toMatchObject({ message: "read https://example.com/a. and https://b.test", link: "https://example.com/a" });
  });

  it("publishes one photo with a caption, preferring post_id", async () => {
    graph.fallback({ kind: "ok", body: { id: "photo1", post_id: `${PAGE}_55` } });
    const r = await advanceFacebook(ctx("look https://example.com", 1));
    expect(r).toMatchObject({ kind: "done", externalId: `${PAGE}_55` });
    expect(graph.requests[0]!.path).toMatch(photos);
    expect(graph.requests[0]!.params).toEqual({ url: "https://media.test/1.jpg", caption: "look https://example.com", access_token: "[redacted]" });
  });

  it("omits an empty caption", async () => {
    graph.fallback({ kind: "ok", body: { id: "photo1" } });
    const r = await advanceFacebook(ctx("", 1));
    expect(r).toMatchObject({ kind: "done", externalId: "photo1" });
    expect(graph.requests[0]!.params).not.toHaveProperty("caption");
  });

  it("uploads unpublished photos, then publishes with attached_media in order", async () => {
    let n = 0;
    graph.on("POST", `/v26.0/${PAGE}/photos`, () => ({ kind: "ok", body: { id: `ph${++n}` } }));
    graph.on("POST", `/v26.0/${PAGE}/feed`, { kind: "ok", body: { id: `${PAGE}_77` } });
    let state: unknown = null;
    for (let i = 1; i <= 3; i++) {
      const c = ctx("trip", 3, state);
      expect(c.step.name).toBe(`upload_photo_${i}`);
      const r = await advanceFacebook(c);
      expect(r.kind).toBe("continue");
      state = (r as { state: unknown }).state;
    }
    expect(state).toEqual({ v: 1, photoIds: ["ph1", "ph2", "ph3"] });
    const last = await advanceFacebook(ctx("trip", 3, state));
    expect(last).toMatchObject({ kind: "done", externalId: `${PAGE}_77` });
    const reqs = graph.requests;
    expect(reqs.slice(0, 3).every((r) => r.params.published === "false")).toBe(true);
    expect(reqs[3]!.params.message).toBe("trip");
    expect(JSON.parse(reqs[3]!.params.attached_media!)).toEqual([{ media_fbid: "ph1" }, { media_fbid: "ph2" }, { media_fbid: "ph3" }]);
    expect(paths()).toEqual([`/${PAGE}/photos`, `/${PAGE}/photos`, `/${PAGE}/photos`, `/${PAGE}/feed`]);
  });

  it("never sends scheduled_publish_time or published=false on a publishing request", async () => {
    graph.fallback({ kind: "ok", body: { id: "x" } });
    await advanceFacebook(ctx("a", 0));
    await advanceFacebook(ctx("a", 1));
    for (const r of graph.requests) {
      expect(r.params).not.toHaveProperty("scheduled_publish_time");
      expect(r.params).not.toHaveProperty("published");
    }
  });

  it("refuses a mismatched step without sending", async () => {
    const r = await advanceFacebook(ctx("a", 0, null, "publish_photo"));
    expect(r).toMatchObject({ kind: "fatal_error", error: "The post changed while publishing." });
    expect(graph.requests).toHaveLength(0);
  });

  it("flags unreadable credentials without sending", async () => {
    const c = ctx("a", 0);
    c.account.credentials = { nope: 1 };
    expect(await advanceFacebook(c)).toMatchObject({ kind: "fatal_error", credentialsInvalid: true });
    expect(graph.requests).toHaveLength(0);
  });

  it("is ambiguous when a publishing 2xx has no id; an upload without id retries", async () => {
    graph.fallback({ kind: "missing_id" });
    expect((await advanceFacebook(ctx("a", 0))).kind).toBe("ambiguous");
    expect((await advanceFacebook(ctx("a", 2))).kind).toBe("retryable_error");
  });

  it("adds the public-URL hint to a rejected photo", async () => {
    graph.fallback({ kind: "graph_error", code: 100, message: "Could not fetch image" });
    const r = await advanceFacebook(ctx("a", 1));
    expect(r).toMatchObject({ kind: "fatal_error" });
    expect((r as { error: string }).error).toContain(docsUrl("storage"));
  });

  it("does not leak the token in results", async () => {
    graph.fallback({ kind: "graph_error", code: 100, message: `bad ${TOKEN}` });
    expect(JSON.stringify(await advanceFacebook(ctx("a", 0)))).not.toContain(TOKEN);
  });
});

describe("publish_video", () => {
  const videos = `/v26.0/${PAGE}/videos`;
  const bodyOf = (i = 0) => {
    const r = graph.requests[i]!;
    return { get: (k: string) => r.params[k] ?? null, has: (k: string) => k in r.params };
  };

  it("posts file_url and description, and is done with the returned id", async () => {
    graph.on("POST", videos, { kind: "ok", body: { id: "vid1" } });
    const r = await advanceFacebook(videoCtx("hello"));
    expect(r).toMatchObject({ kind: "done", externalId: "vid1" });
    expect(graph.requests).toHaveLength(1);
    const p = bodyOf();
    expect(p.get("file_url")).toBe("https://media.test/1.mp4");
    expect(p.get("description")).toBe("hello");
    expect(p.get("access_token")).toBe("[redacted]");
    for (const k of ["published", "title", "thumb", "scheduled_publish_time", "source", "upload_phase", "link"]) expect(p.has(k)).toBe(false);
  });

  it("omits description when the text is empty", async () => {
    graph.on("POST", videos, { kind: "ok", body: { id: "vid1" } });
    await advanceFacebook(videoCtx(""));
    expect(bodyOf().has("description")).toBe(false);
  });

  it("does not turn a link in the text into a link param", async () => {
    graph.on("POST", videos, { kind: "ok", body: { id: "vid1" } });
    await advanceFacebook(videoCtx("see https://example.com"));
    expect(bodyOf().has("link")).toBe(false);
  });

  it("a reply with no id is ambiguous", async () => {
    graph.on("POST", videos, { kind: "ok", body: {} });
    expect((await advanceFacebook(videoCtx("x"))).kind).toBe("ambiguous");
  });

  it("a rate limit is retryable", async () => {
    graph.on("POST", videos, { kind: "graph_error", code: 4, message: "slow down", status: 400 });
    expect((await advanceFacebook(videoCtx("x"))).kind).toBe("retryable_error");
  });

  it("code 190 is fatal and flags the account", async () => {
    graph.on("POST", videos, { kind: "graph_error", code: 190, message: "bad token", status: 400 });
    expect(await advanceFacebook(videoCtx("x"))).toMatchObject({ kind: "fatal_error", credentialsInvalid: true });
  });

  it("code 389 is fatal with the public-storage guidance", async () => {
    graph.on("POST", videos, { kind: "graph_error", code: 389, message: "Unable to fetch video file from URL.", status: 400 });
    const r = await advanceFacebook(videoCtx("x"));
    expect(r.kind).toBe("fatal_error");
    if (r.kind === "fatal_error") {
      expect(r.error).toContain("Unable to fetch video file");
      expect(r.error).toContain(docsUrl("storage"));
    }
  });

  it("5xx is ambiguous (may have published)", async () => {
    graph.on("POST", videos, { kind: "graph_error", code: 1, message: "oops", status: 500 });
    expect((await advanceFacebook(videoCtx("x"))).kind).toBe("ambiguous");
  });
});

describe("Reel steps", () => {
  const reels = `/v26.0/${PAGE}/video_reels`;
  const status = "/v26.0/55";
  const UP = "https://rupload.facebook.com/video-upload/55";
  const reelState = (o: Record<string, unknown> = {}) => ({
    v: 1, kind: "reel", videoId: "55", uploadUrl: UP, startedAt: now.toISOString(),
    uploadedAt: null, uploadComplete: false, uploadChecks: 0, finishedAt: null, publishChecks: 0, ...o,
  });
  const again = (m: string, p: string, r: Parameters<FakeGraph["on"]>[2]) => {
    graph.reset();
    graph.on(m, p, r);
  };
  const at = (min: number) => new Date(now.getTime() + min * 60_000);
  function reelCtx(state: unknown, at_: Date = now, text = "hi"): PublishContext {
    const c = videoCtx(text);
    const content = { text, mediaCount: 1, kinds: ["video" as const], postType: "reel" as const };
    return { ...c, postType: "reel", state, now: at_, step: facebookStepFor(state, content) };
  }
  const uploaded = (o: Record<string, unknown> = {}) => reelState({ uploadedAt: now.toISOString(), ...o });
  const finished = (o: Record<string, unknown> = {}) => uploaded({ uploadComplete: true, finishedAt: now.toISOString(), ...o });
  const phases = (u: string, p: string, v: string, ps?: string) => ({
    kind: "ok" as const,
    body: { status: { video_status: v, uploading_phase: { status: u }, processing_phase: { status: p }, publishing_phase: { status: "not_started", ...(ps ? { publish_status: ps } : {}) } } },
  });

  it("start_reel posts upload_phase=start and saves the state", async () => {
    graph.on("POST", reels, { kind: "ok", body: { video_id: "55", upload_url: UP } });
    const r = await advanceFacebook(reelCtx(null));
    expect(graph.requests[0]!.params).toEqual({ upload_phase: "start", access_token: "[redacted]" });
    expect(r).toMatchObject({ kind: "continue", state: reelState() });
    expect(r.kind === "continue" && r.notBefore).toBeFalsy();
    expect(r.summary?.request).toEqual({ step: "start_reel", kind: "reel", videoId: "55" });
  });

  it("start_reel without an upload address is retryable", async () => {
    graph.on("POST", reels, { kind: "ok", body: { video_id: "55" } });
    expect((await advanceFacebook(reelCtx(null))).kind).toBe("retryable_error");
  });

  it("upload_reel sends file_url and the token in the header only, with no body", async () => {
    const r = await advanceFacebook(reelCtx(reelState()));
    expect(graph.requests).toHaveLength(1);
    const q = graph.requests[0]!;
    expect(q.host).toBe("rupload.facebook.com");
    expect(q.headers.file_url).toBe("https://media.test/1.mp4");
    expect(q.headers.authorization).toBe("[redacted]");
    expect(q.bodyBytes).toBe(0);
    expect(r).toMatchObject({ kind: "continue", state: reelState({ uploadedAt: now.toISOString() }), notBefore: at(1) });
    expect(r.summary?.request).toMatchObject({ uploadHost: "rupload.facebook.com" });
    expect(JSON.stringify(r.summary)).not.toContain("video-upload");
  });

  it("upload_reel with a bad address is fatal and sends nothing", async () => {
    const r = await advanceFacebook(reelCtx(reelState({ uploadUrl: "https://evil.example/video-upload/55" })));
    expect(r).toMatchObject({ kind: "fatal_error", error: "Facebook returned an unexpected upload address; nothing was sent or published." });
    expect(graph.requests).toHaveLength(0);
  });

  it("upload_reel maps errors", async () => {
    const path = "/video-upload/55";
    graph.on("POST", path, { kind: "http", status: 503 });
    expect((await advanceFacebook(reelCtx(reelState()))).kind).toBe("retryable_error");
    again("POST", path, { kind: "pre_send_failure" });
    expect((await advanceFacebook(reelCtx(reelState()))).kind).toBe("retryable_error");
    again("POST", path, { kind: "graph_error", code: 190, message: "bad", status: 400 });
    expect(await advanceFacebook(reelCtx(reelState()))).toMatchObject({ kind: "fatal_error", credentialsInvalid: true });
    again("POST", path, { kind: "http", status: 400 });
    const r = await advanceFacebook(reelCtx(reelState()));
    expect(r).toMatchObject({ kind: "fatal_error" });
    expect(r.kind === "fatal_error" && r.error).toContain("Nothing was published");
  });

  it("check_upload: pending waits at the pace, complete continues, failed is fatal", async () => {
    graph.on("GET", status, phases("in_progress", "not_started", "upload_in_progress"));
    expect(await advanceFacebook(reelCtx(uploaded(), at(1)))).toMatchObject({
      kind: "continue", state: uploaded({ uploadChecks: 1 }), notBefore: at(2),
    });
    expect(graph.requests[0]!.params.fields).toBe("status");
    expect(await advanceFacebook(reelCtx(uploaded(), at(6)))).toMatchObject({ notBefore: at(11) });
    again("GET", status, phases("complete", "not_started", "upload_complete"));
    const done = await advanceFacebook(reelCtx(uploaded(), at(2)));
    expect(done).toMatchObject({ kind: "continue", state: uploaded({ uploadComplete: true, uploadChecks: 1 }) });
    expect(done.kind === "continue" && done.notBefore).toBeFalsy();
    again("GET", status, phases("error", "not_started", "error"));
    expect((await advanceFacebook(reelCtx(uploaded(), at(2)))).kind).toBe("fatal_error");
  });

  it("check_upload: dropped reads keep waiting until 30 minutes, then fail", async () => {
    graph.on("GET", status, { kind: "http", status: 500 });
    expect((await advanceFacebook(reelCtx(uploaded(), at(5)))).kind).toBe("continue");
    again("GET", status, { kind: "unparseable" });
    expect((await advanceFacebook(reelCtx(uploaded(), at(29)))).kind).toBe("continue");
    expect(await advanceFacebook(reelCtx(uploaded(), at(30)))).toMatchObject({
      kind: "fatal_error", error: "Facebook did not receive the video within 30 minutes; nothing was published.",
    });
    again("GET", status, { kind: "graph_error", code: 190, message: "bad", status: 400 });
    expect(await advanceFacebook(reelCtx(uploaded(), at(2)))).toMatchObject({ kind: "fatal_error", credentialsInvalid: true });
  });

  it("finish_reel posts the finish params and is the only publishing Reel step", async () => {
    graph.on("POST", reels, { kind: "ok", body: { success: true } });
    const c = reelCtx(uploaded({ uploadComplete: true }));
    expect(c.step).toEqual({ name: "finish_reel", mayPublish: true });
    const r = await advanceFacebook(c);
    expect(graph.requests[0]!.params).toEqual({
      upload_phase: "finish", video_id: "55", video_state: "PUBLISHED", description: "hi", access_token: "[redacted]",
    });
    expect(r).toMatchObject({ kind: "continue", state: finished({ uploadComplete: true }), notBefore: at(1) });
  });

  it("finish_reel: unreadable is ambiguous, a drop is ambiguous, a refusal is fatal", async () => {
    const c = () => reelCtx(uploaded({ uploadComplete: true }));
    graph.on("POST", reels, { kind: "ok", body: { success: false } });
    expect((await advanceFacebook(c())).kind).toBe("ambiguous");
    again("POST", reels, { kind: "unparseable" });
    expect((await advanceFacebook(c())).kind).toBe("ambiguous");
    again("POST", reels, { kind: "reset_mid_body" });
    expect((await advanceFacebook(c())).kind).toBe("ambiguous");
    again("POST", reels, { kind: "graph_error", code: 4, status: 400 });
    expect((await advanceFacebook(c())).kind).toBe("retryable_error");
    again("POST", reels, { kind: "graph_error", code: 1363127, message: "bad", status: 400 });
    expect((await advanceFacebook(c())).kind).toBe("fatal_error");
  });

  it("check_publish: published is done with the video id", async () => {
    graph.on("GET", status, phases("complete", "complete", "ready", "published"));
    const r = await advanceFacebook(reelCtx(finished(), at(1)));
    expect(r).toMatchObject({ kind: "done", externalId: "55" });
    expect(r.summary?.response).toMatchObject({ videoStatus: "ready", publishStatus: "published", checks: 1 });
  });

  it("check_publish: processing waits; failed is the only fatal; never retryable", async () => {
    graph.on("GET", status, phases("complete", "in_progress", "processing"));
    expect(await advanceFacebook(reelCtx(finished(), at(1)))).toMatchObject({ kind: "continue", state: finished({ publishChecks: 1 }), notBefore: at(2) });
    for (const reply of [{ kind: "http" as const, status: 500 }, { kind: "http" as const, status: 429 }, { kind: "unparseable" as const }, { kind: "pre_send_failure" as const }, { kind: "graph_error" as const, code: 4, status: 400 }, { kind: "graph_error" as const, code: 100, status: 400 }]) {
      again("GET", status, reply);
      expect((await advanceFacebook(reelCtx(finished(), at(1)))).kind).toBe("continue");
    }
    again("GET", status, {
      kind: "ok",
      body: { status: { video_status: "error", processing_phase: { status: "error", errors: [{ message: `bad ${TOKEN} frame` }] } } },
    });
    const f = await advanceFacebook(reelCtx(finished(), at(1)));
    expect(f.kind).toBe("fatal_error");
    expect(JSON.stringify(f)).not.toContain(TOKEN);
    expect(f.kind === "fatal_error" && f.error).toContain("9:16");
    expect(f.summary?.response).toHaveProperty("statusDetail");
  });

  it("check_publish: 190 and the 60-minute ceiling are ambiguous", async () => {
    graph.on("GET", status, { kind: "graph_error", code: 190, message: "bad", status: 400 });
    expect(await advanceFacebook(reelCtx(finished(), at(1)))).toMatchObject({ kind: "ambiguous", credentialsInvalid: true });
    again("GET", status, phases("complete", "in_progress", "processing"));
    expect((await advanceFacebook(reelCtx(finished(), at(59)))).kind).toBe("continue");
    expect((await advanceFacebook(reelCtx(finished(), at(60)))).kind).toBe("ambiguous");
  });

  it("an unreadable saved state on a video is ambiguous with no request", async () => {
    const c = { ...reelCtx(reelState()), state: { junk: 1 }, step: { name: "invalid", mayPublish: false, afterPublish: true as const } };
    expect((await advanceFacebook(c)).kind).toBe("ambiguous");
    expect(graph.requests).toHaveLength(0);
  });
});
