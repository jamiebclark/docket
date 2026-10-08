import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docsUrl } from "@/lib/docs";
import { createFakeGraph, type FakeGraph } from "../../../tests/helpers/fake-graph";
import type { MediaItem, PublishContext } from "../types";
import { advanceThreads } from "./publish";
import { VIDEO_PROCESSING_CAP_MS, type ThreadsState } from "./state";
import { threadsStepFor } from "./steps";

const USER = "17841400000000001";
const TOKEN = "THQW-threads-token-0123456789abcdef";
const now = new Date("2026-01-01T00:00:00Z");
const vid: MediaItem = { url: "https://media.test/1.mp4", mimeType: "video/mp4", width: 1080, height: 1920, bytes: 1000, altText: "a clip", kind: "video" };

let graph: FakeGraph;
beforeEach(() => {
  graph = createFakeGraph().install();
});
afterEach(() => graph.uninstall());

const videoState = (over: Partial<ThreadsState> = {}): ThreadsState => ({
  v: 1,
  mediaType: "VIDEO",
  items: [],
  container: "5001",
  createdAt: now.toISOString(),
  checks: 0,
  ready: false,
  quotaChecked: false,
  recreations: 0,
  ...over,
});

function ctx(text: string, state: unknown = null, at: Date = now): PublishContext {
  return {
    target: { id: "t1", scheduledAt: now, attempt: 1 },
    account: { id: "a1", externalId: USER, displayName: "@docket", settings: {}, credentials: { v: 1, accessToken: TOKEN, issuedAt: 0, expiresAt: Date.now() + 1e9, expiryEstimated: false } },
    content: { text, media: [vid] },
    postType: "video",
    step: threadsStepFor(state, { text, mediaCount: 1, kinds: ["video"] }),
    state,
    now: at,
    signal: new AbortController().signal,
  };
}

const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);

describe("Threads single video: create_container", () => {
  it("sends VIDEO with video_url and text, and none of the image keys", async () => {
    graph.fallback({ kind: "ok", body: { id: "5001" } });
    const r = await advanceThreads(ctx("hello"));
    expect(r).toMatchObject({ kind: "continue", state: { mediaType: "VIDEO", container: "5001" } });
    expect((r as { notBefore: Date }).notBefore.getTime()).toBe(now.getTime() + 30_000);
    const p = graph.requests[0]!.params;
    expect(p).toEqual({ media_type: "VIDEO", video_url: vid.url, text: "hello", access_token: "[redacted]" });
    for (const k of ["image_url", "alt_text", "is_carousel_item", "children"]) expect(p).not.toHaveProperty(k);
  });

  it("omits text when the target has none", async () => {
    graph.fallback({ kind: "ok", body: { id: "5001" } });
    await advanceThreads(ctx(""));
    expect(graph.requests[0]!.params).not.toHaveProperty("text");
  });

  it("explains a fetch refusal with the media wording", async () => {
    graph.fallback({ kind: "graph_error", code: 100, message: "Failed to fetch the video from this url", status: 400 });
    const r = await advanceThreads(ctx("hello"));
    expect(r).toMatchObject({ kind: "fatal_error" });
    expect((r as { error: string }).error).toContain(`Media must be at a public URL (see ${docsUrl("storage")}).`);
  });
});

describe("Threads single video: check_status", () => {
  const read = async (reply: unknown, state = videoState(), when = at(30)) => {
    graph.fallback({ kind: "ok", body: reply } as never);
    const r = await advanceThreads(ctx("hello", state, when));
    return r;
  };

  it("reads status,error_message", async () => {
    await read({ status: "FINISHED" });
    expect(graph.requests[0]!.params).toMatchObject({ fields: "status,error_message" });
  });

  it("FINISHED marks ready", async () => {
    expect(await read({ status: "FINISHED" })).toMatchObject({ kind: "continue", state: { ready: true, checks: 1 } });
  });

  it("IN_PROGRESS waits 60 s while under 5 minutes, then 5 minutes", async () => {
    const young = await read({ status: "IN_PROGRESS" }, videoState(), at(90));
    expect((young as { notBefore: Date }).notBefore.getTime()).toBe(at(90).getTime() + 60_000);
    const old = await read({ status: "IN_PROGRESS" }, videoState(), at(301));
    expect((old as { notBefore: Date }).notBefore.getTime()).toBe(at(301).getTime() + 300_000);
  });

  it("IN_PROGRESS just under the ceiling continues; at it, fails with the ceiling message", async () => {
    const under = await read({ status: "IN_PROGRESS" }, videoState(), new Date(now.getTime() + VIDEO_PROCESSING_CAP_MS - 1));
    expect(under.kind).toBe("continue");
    const over = await read({ status: "IN_PROGRESS" }, videoState(), new Date(now.getTime() + VIDEO_PROCESSING_CAP_MS));
    expect(over).toMatchObject({
      kind: "fatal_error",
      error: "Threads did not finish processing the video within 60 minutes; nothing was published. Retry the post to try again.",
    });
  });

  it("ERROR explains a documented code and records the raw message", async () => {
    const r = await read({ status: "ERROR", error_message: "FAILED_PROCESSING_VIDEO" });
    expect(r).toMatchObject({ kind: "fatal_error" });
    const e = (r as { error: string; summary: { response: Record<string, unknown> } });
    expect(e.error).toBe(
      "Threads could not process the video: FAILED_PROCESSING_VIDEO. Threads could not process the file, usually because of its encoding. Nothing was published; retry the post after fixing the video.",
    );
    expect(e.summary.response.errorMessage).toBe("FAILED_PROCESSING_VIDEO");
  });

  it("ERROR without a message says status ERROR", async () => {
    expect(await read({ status: "ERROR" })).toMatchObject({ error: expect.stringContaining("Threads could not process the video (status ERROR).") });
  });

  it("EXPIRED recreates the container", async () => {
    expect(await read({ status: "EXPIRED" })).toMatchObject({ kind: "continue", state: { mediaType: "VIDEO", container: null, recreations: 1 } });
  });

  it("PUBLISHED is ambiguous; unknown and unreadable bodies retry", async () => {
    expect(await read({ status: "PUBLISHED" })).toMatchObject({ kind: "ambiguous" });
    expect(await read({ status: "WAT" })).toMatchObject({ kind: "retryable_error" });
    expect(await read("garbage")).toMatchObject({ kind: "retryable_error" });
  });

  it("never leaks the token into a result", async () => {
    const r = await read({ status: "ERROR", error_message: `bad ${TOKEN}` });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("omits errorMessage from the summary when empty", async () => {
    const r = await read({ status: "IN_PROGRESS" });
    expect((r as { summary: { response: Record<string, unknown> } }).summary.response).not.toHaveProperty("errorMessage");
  });
});

// --- carousel -------------------------------------------------------------------------------
const img: MediaItem = { url: "https://media.test/i.jpg", mimeType: "image/jpeg", width: 100, height: 100, bytes: 10, altText: "alt", kind: "image" };
const KINDS = ["image", "video", "image"] as const;

function cctx(kinds: readonly ("image" | "video")[], state: unknown, at: Date = now, text = "hello"): PublishContext {
  const media = kinds.map((k, i) => ({ ...(k === "video" ? vid : img), url: `https://media.test/${i + 1}.${k === "video" ? "mp4" : "jpg"}` }));
  return {
    ...ctx(text),
    content: { text, media },
    step: threadsStepFor(state, { text, mediaCount: kinds.length, kinds: [...kinds] }),
    state,
    now: at,
  };
}

const prog = (createdAt: Date, ready: boolean) => ({ createdAt: createdAt.toISOString(), checks: 0, ready });
const cState = (over: Partial<ThreadsState> = {}): ThreadsState => ({
  v: 1,
  mediaType: "CAROUSEL",
  kinds: [...KINDS],
  itemProgress: [prog(now, true), prog(now, false), prog(now, true)],
  items: ["11", "12", "13"],
  container: null,
  createdAt: null,
  checks: 0,
  ready: false,
  quotaChecked: false,
  recreations: 0,
  ...over,
});

describe("Threads carousel with video: item creates", () => {
  it("sends a video item without text, alt_text or image_url", async () => {
    graph.fallback({ kind: "ok", body: { id: "12" } });
    const s = cState({ items: ["11"], itemProgress: [prog(now, true)] });
    const r = await advanceThreads(cctx(KINDS, s));
    expect(graph.requests[0]!.params).toEqual({ media_type: "VIDEO", video_url: "https://media.test/2.mp4", is_carousel_item: "true", access_token: "[redacted]" });
    expect(r).toMatchObject({ kind: "continue", state: { items: ["11", "12"] } });
    expect((r as { notBefore?: Date }).notBefore).toBeUndefined();
  });

  it("an image item is unchanged and saved ready", async () => {
    graph.fallback({ kind: "ok", body: { id: "11" } });
    const r = await advanceThreads(cctx(KINDS, cState({ items: [], itemProgress: [] })));
    expect(graph.requests[0]!.params).toEqual({ media_type: "IMAGE", image_url: "https://media.test/1.jpg", is_carousel_item: "true", alt_text: "alt", access_token: "[redacted]" });
    expect((r as { state: ThreadsState }).state.itemProgress).toEqual([{ createdAt: now.toISOString(), checks: 0, ready: true }]);
  });

  it("the last item create is followed by a read due 30 s after the first unready item's creation", async () => {
    graph.fallback({ kind: "ok", body: { id: "13" } });
    const s = cState({ items: ["11", "12"], itemProgress: [prog(now, true), prog(now, false)] });
    const r = await advanceThreads(cctx(KINDS, s, at(5)));
    expect((r as { notBefore: Date }).notBefore.getTime()).toBe(now.getTime() + 30_000);
  });
});

describe("Threads carousel with video: create_carousel", () => {
  it("sends children in post order for a 20-item mixed carousel, and no alt_text", async () => {
    const kinds = Array.from({ length: 20 }, (_, i) => (i % 3 === 1 ? "video" : "image") as "image" | "video");
    const ids = kinds.map((_, i) => String(100 + i));
    const s = cState({ kinds, items: ids, itemProgress: kinds.map(() => prog(now, true)) });
    graph.fallback({ kind: "ok", body: { id: "9000" } });
    const r = await advanceThreads(cctx(kinds, s));
    expect(graph.requests[0]!.params).toEqual({ media_type: "CAROUSEL", children: ids.join(","), text: "hello", access_token: "[redacted]" });
    expect(r).toMatchObject({ kind: "continue", state: { container: "9000" } });
    expect((r as { notBefore: Date }).notBefore.getTime()).toBe(now.getTime() + 30_000);
  });
});

describe("Threads carousel with video: check_item_<k>", () => {
  const read = async (reply: unknown, state = cState(), when = at(30)) => {
    graph.fallback({ kind: "ok", body: reply } as never);
    return advanceThreads(cctx(KINDS, state, when));
  };

  it("reads only the video item", async () => {
    await read({ status: "FINISHED" });
    expect(graph.requests).toHaveLength(1);
    expect(graph.requests[0]).toMatchObject({ method: "GET", path: "/v1.0/12" });
    expect(graph.requests[0]!.params).toMatchObject({ fields: "status,error_message" });
  });

  it("FINISHED marks the item ready", async () => {
    const r = await read({ status: "FINISHED" });
    expect(r).toMatchObject({ kind: "continue", state: { itemProgress: [{ ready: true }, { ready: true, checks: 1 }, { ready: true }] } });
    expect((r as { notBefore?: Date }).notBefore).toBeUndefined();
  });

  it("FINISHED points the next read at the next unready item", async () => {
    const s = cState({ kinds: ["video", "video"], items: ["11", "12"], itemProgress: [prog(now, false), prog(at(10), false)] });
    graph.fallback({ kind: "ok", body: { status: "FINISHED" } });
    const r = await advanceThreads(cctx(["video", "video"], s, at(40)));
    expect((r as { notBefore: Date }).notBefore.getTime()).toBe(at(40).getTime());
  });

  it("IN_PROGRESS counts the read and waits per the item's own age", async () => {
    const r = await read({ status: "IN_PROGRESS" }, cState(), at(301));
    expect(r).toMatchObject({ kind: "continue", state: { itemProgress: [{}, { checks: 1 }, {}] } });
    expect((r as { notBefore: Date }).notBefore.getTime()).toBe(at(301).getTime() + 300_000);
  });

  it("fails at the item's own 60-minute ceiling", async () => {
    const r = await read({ status: "IN_PROGRESS" }, cState(), new Date(now.getTime() + VIDEO_PROCESSING_CAP_MS));
    expect(r).toMatchObject({ kind: "fatal_error", error: expect.stringContaining("within 60 minutes") });
  });

  it("ERROR names the item's position", async () => {
    const r = await read({ status: "ERROR", error_message: "INVALID_DURATION" });
    expect((r as { error: string }).error).toBe(
      "Threads could not process the video in item 2 of the carousel: INVALID_DURATION. Threads videos can be at most 300 seconds. Nothing was published; retry the post after fixing the video.",
    );
    expect((r as { summary: { request: Record<string, unknown> } }).summary.request).toMatchObject({ step: "check_item_2", containerId: "12", itemIndex: 2, itemKind: "video" });
  });

  it("EXPIRED recreates the whole post; PUBLISHED is ambiguous; unknown retries", async () => {
    expect(await read({ status: "EXPIRED" })).toMatchObject({ kind: "continue", state: { items: [], recreations: 1 } });
    expect(await read({ status: "PUBLISHED" })).toMatchObject({ kind: "ambiguous" });
    expect(await read({ status: "WAT" })).toMatchObject({ kind: "retryable_error" });
  });

  it("never leaks the token", async () => {
    const r = await read({ status: "ERROR", error_message: `bad ${TOKEN}` });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe("Threads carousel with video: parent and quota", () => {
  const parent = (over: Partial<ThreadsState> = {}) => cState({ itemProgress: [prog(now, true), prog(now, true), prog(now, true)], container: "9000", createdAt: at(60).toISOString(), ...over });

  it("reads the parent at the video pace and fails with the carousel message on ERROR", async () => {
    graph.fallback({ kind: "ok", body: { status: "IN_PROGRESS" } });
    const r = await advanceThreads(cctx(KINDS, parent(), at(400)));
    expect((r as { notBefore: Date }).notBefore.getTime()).toBe(at(400).getTime() + 300_000);
    graph.fallback({ kind: "ok", body: { status: "ERROR", error_message: "boom" } });
    const e = await advanceThreads(cctx(KINDS, parent(), at(100)));
    expect((e as { error: string }).error).toContain("Threads could not process the video carousel: boom.");
  });

  it("check_quota recreates (AGED) from the oldest item, not only the parent", async () => {
    const old = new Date(now.getTime() + 23 * 3_600_000 - 1000);
    const s = parent({ ready: true, createdAt: old.toISOString() });
    const r = await advanceThreads(cctx(KINDS, s, new Date(now.getTime() + 23 * 3_600_000)));
    expect(r).toMatchObject({ kind: "continue", state: { items: [], container: null, recreations: 1 } });
    expect(graph.requests).toHaveLength(0);
  });

  it("an image-only carousel still reads the parent at 60 s with the 5-minute cap", async () => {
    const s: ThreadsState = { ...cState(), kinds: undefined, itemProgress: undefined, container: "9000", createdAt: now.toISOString() };
    delete s.kinds;
    delete s.itemProgress;
    graph.fallback({ kind: "ok", body: { status: "IN_PROGRESS" } });
    const r = await advanceThreads(cctx(["image", "image", "image"], s, at(60)));
    expect((r as { notBefore: Date }).notBefore.getTime()).toBe(at(60).getTime() + 60_000);
    const over = await advanceThreads(cctx(["image", "image", "image"], s, at(300)));
    expect(over).toMatchObject({ kind: "fatal_error", error: "Threads did not finish processing the post." });
  });
});
