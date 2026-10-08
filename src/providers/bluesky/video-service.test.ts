import { XRPCError } from "@atproto/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VIDEO_SERVICE_URL, VideoServiceError, finishUpload, getJobStatus, getUploadLimits, serviceToken, startUpload, uploadPart } from "./video-service";

interface Seen { url: string; init: RequestInit }
const seen: Seen[] = [];
function stub(reply: (url: string) => Response) {
  seen.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init: init ?? {} });
    return reply(url);
  });
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const signal = new AbortController().signal;
const now = new Date("2026-10-08T12:00:00Z");
afterEach(() => vi.unstubAllGlobals());

describe("serviceToken", () => {
  it("asks the PDS for a method-scoped token that expires in 5 minutes", async () => {
    stub(() => json({ token: "T1" }));
    const token = await serviceToken({ pdsUrl: "https://pds.test", accessJwt: "JWT", now, signal }, "did:web:video.bsky.app", "app.bsky.video.getJobStatus");
    expect(token).toBe("T1");
    const url = new URL(seen[0]!.url);
    expect(url.origin + url.pathname).toBe("https://pds.test/xrpc/com.atproto.server.getServiceAuth");
    expect(url.searchParams.get("aud")).toBe("did:web:video.bsky.app");
    expect(url.searchParams.get("lxm")).toBe("app.bsky.video.getJobStatus");
    expect(url.searchParams.get("exp")).toBe(String(Math.floor(now.getTime() / 1000) + 300));
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer JWT");
  });
  it("throws XRPCError on a refusal and on a reply with no token", async () => {
    stub(() => json({ error: "BadExpiration", message: "no" }, 400));
    await expect(serviceToken({ pdsUrl: "https://pds.test", accessJwt: "J", now, signal }, "a", "b")).rejects.toMatchObject({ status: 400, error: "BadExpiration" });
    stub(() => json({}));
    await expect(serviceToken({ pdsUrl: "https://pds.test", accessJwt: "J", now, signal }, "a", "b")).rejects.toBeInstanceOf(XRPCError);
  });
});

describe("video service calls", () => {
  it("sends the token only to the video service, with the exact URLs and bodies", async () => {
    stub(() => json({ canUpload: true, remainingDailyVideos: 9, remainingDailyBytes: 5 }));
    expect(await getUploadLimits({ token: "TK", signal })).toEqual({ canUpload: true, remainingDailyVideos: 9, remainingDailyBytes: 5 });
    stub(() => json({ jobId: "j" }));
    await startUpload({ token: "TK", signal }, { sizeBytes: 5, mimeType: "video/mp4", name: "n.mp4" });
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ sizeBytes: 5, mimeType: "video/mp4", name: "n.mp4" });
    await uploadPart({ token: "TK", signal }, "j1", 2, new Uint8Array([1, 2, 3]));
    expect(seen[1]!.url).toBe(`${VIDEO_SERVICE_URL}/xrpc/app.bsky.video.uploadPart?jobId=j1&partNumber=2`);
    expect((seen[1]!.init.headers as Record<string, string>)["content-length"]).toBe("3");
    expect((seen[1]!.init.headers as Record<string, string>)["content-type"]).toBe("application/octet-stream");
    await finishUpload({ token: "TK", signal }, "j1");
    expect(JSON.parse(String(seen[2]!.init.body))).toEqual({ jobId: "j1" });
    await getJobStatus({ token: "TK", signal }, "j2");
    expect(seen[3]!.url).toBe(`${VIDEO_SERVICE_URL}/xrpc/app.bsky.video.getJobStatus?jobId=j2`);
    for (const s of seen) {
      expect(s.url.startsWith("https://video.bsky.app/")).toBe(true);
      expect((s.init.headers as Record<string, string>).authorization).toBe("Bearer TK");
    }
  });
  it("can read a status with no token", async () => {
    stub(() => json({ jobStatus: {} }));
    await getJobStatus({ token: null, signal }, "j");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });
  it("throws a VideoServiceError (an XRPCError) that keeps the body and Retry-After", async () => {
    const body = { error: "DailyLimitExceeded", message: "m", jobStatus: { blob: { x: 1 } } };
    stub(() => json(body, 429, { "retry-after": "30" }));
    const err = await startUpload({ token: "T", signal }, { sizeBytes: 1, mimeType: "video/mp4", name: "n" }).catch((e) => e);
    expect(err).toBeInstanceOf(VideoServiceError);
    expect(err).toBeInstanceOf(XRPCError);
    expect(err).toMatchObject({ status: 429, error: "DailyLimitExceeded", message: "m", body });
    expect(err.headers["retry-after"]).toBe("30");
  });
  it("turns an unreadable 200 into status 2", async () => {
    stub(() => new Response("not json", { status: 200 }));
    await expect(finishUpload({ token: "T", signal }, "j")).rejects.toMatchObject({ status: 2 });
  });
});
