import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePds, mintJwt, type FakePds } from "../../../tests/helpers/fake-pds";
import type { PublishContext, StepResult } from "../types";
import { advance } from "./publish";
import { readRange, storedSize } from "./media-range";

const DID = "did:plc:alice";
const ACCESS = mintJwt(new Date("2026-01-01T01:00:00Z"));
const REFRESH = mintJwt(new Date("2026-03-01T00:00:00Z"));
const CID = "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgzmq2vz2m";
const now = new Date("2026-01-01T00:00:00Z");
const MEDIA = "https://media.example.test/v.mp4";
const SIZE = 12_000_000;
const PART = 5_000_000;
const blob = { $type: "blob" as const, ref: { $link: CID }, mimeType: "video/mp4" as const, size: SIZE };

const P = {
  auth: "/xrpc/com.atproto.server.getServiceAuth",
  session: "/xrpc/com.atproto.server.getSession",
  limits: "/xrpc/app.bsky.video.getUploadLimits",
  start: "/xrpc/app.bsky.video.startUpload",
  part: "/xrpc/app.bsky.video.uploadPart",
  finish: "/xrpc/app.bsky.video.finishUpload",
  job: "/xrpc/app.bsky.video.getJobStatus",
  create: "/xrpc/com.atproto.repo.createRecord",
};

const item = { url: MEDIA, mimeType: "video/mp4", width: 1080, height: 1920, bytes: SIZE, altText: "", kind: "video" as const, video: { container: "mp4", durationSeconds: 30, frameRate: 30, videoCodec: "h264", audioCodec: "aac" } } as const;
const upload = {
  phase: "parts",
  restarts: 0,
  statusAuth: "service",
  pdsHost: "pds.test",
  url: MEDIA,
  sizeBytes: SIZE,
  jobId: "job-1",
  partSizeBytes: PART,
  partCount: 3,
  partsSent: 0,
  expiresAt: "2026-01-01T01:00:00.000Z",
};

function ctx(step: string, video?: object, over: Partial<PublishContext> = {}): PublishContext {
  return {
    target: { id: "t1", scheduledAt: now, attempt: 1 },
    account: {
      id: "a1",
      externalId: DID,
      displayName: "alice",
      settings: { pdsUrl: "https://pds.test" },
      credentials: { accessJwt: ACCESS, refreshJwt: REFRESH, did: DID, handle: "alice.bsky.social" },
    },
    content: { text: "a video", media: [item] },
    postType: "video",
    step: { name: step, mayPublish: step === "create_post" },
    state: video ? { v: 1, video } : null,
    now,
    signal: new AbortController().signal,
    ...over,
  } as PublishContext;
}

let pds: FakePds;
const stored = Buffer.alloc(SIZE);

beforeEach(() => {
  pds = createFakePds();
  pds.route("GET", P.auth, (req) => {
    const q = new URL(req.url).searchParams;
    return { json: { token: `svc.${q.get("aud")}|${q.get("lxm")}` } };
  });
  pds.route("GET", P.session, { json: { didDoc: { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://real.pds.test" }] } } });
  pds.route("GET", P.limits, { json: { canUpload: true, remainingDailyVideos: 20, remainingDailyBytes: 1000 } });
  pds.route("POST", P.start, { json: { jobId: "job-1", partSizeBytes: PART, partCount: 3, expiresAt: "2026-01-01T01:00:00.000Z" } });
  pds.route("POST", P.part, (req) => ({ json: { partNumber: Number(new URL(req.url).searchParams.get("partNumber")) } }));
  pds.route("POST", P.finish, { json: { completedJobId: "job-2", jobStatus: { state: "JOB_STATE_CREATED" } } });
  pds.route("GET", P.job, { json: { jobStatus: { state: "JOB_STATE_COMPLETED", blob } } });
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== "https://media.example.test") return pds.fetch(input, init);
    const m = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get("range") ?? "");
    if (!m) return new Response(stored, { status: 200 });
    const [first, last] = [Number(m[1]), Math.min(Number(m[2]), SIZE - 1)];
    return new Response(stored.subarray(first, last + 1), { status: 206, headers: { "content-range": `bytes ${first}-${last}/${SIZE}` } });
  }) as typeof fetch);
});
afterEach(() => vi.unstubAllGlobals());

const noSecrets = (r: StepResult) => {
  const json = JSON.stringify(r);
  for (const s of [ACCESS, REFRESH, "svc."]) expect(json).not.toContain(s);
};
const videoOf = (r: StepResult) => (r as { state: { video: Record<string, unknown> } }).state.video;

describe("check_upload_limits", () => {
  it("reads the PDS host from the session, then the limits with a video-service token", async () => {
    const r = await advance(ctx("check_upload_limits"));
    expect(r).toMatchObject({ kind: "continue" });
    expect(videoOf(r)).toMatchObject({ phase: "start", limitsCheck: "ok", pdsHost: "real.pds.test", pdsHostSource: "session" });
    const auth = pds.callsTo("GET", P.auth)[0]!;
    const q = new URL(auth.url).searchParams;
    expect([q.get("aud"), q.get("lxm")]).toEqual(["did:web:video.bsky.app", "app.bsky.video.getUploadLimits"]);
    expect(Number(q.get("exp"))).toBe(now.getTime() / 1000 + 300);
    expect(pds.callsTo("GET", P.limits)[0]!.headers.authorization).toBe("Bearer svc.did:web:video.bsky.app|app.bsky.video.getUploadLimits");
    noSecrets(r);
  });

  it("falls back to the configured host when the session has no usable entry", async () => {
    pds.route("GET", P.session, { json: {} });
    expect(videoOf(await advance(ctx("check_upload_limits")))).toMatchObject({ pdsHost: "pds.test", pdsHostSource: "configured" });
  });

  it("waits an hour with a message when refused, and keeps the first refusal's time", async () => {
    pds.route("GET", P.limits, { json: { canUpload: false, message: "Daily limit reached." } });
    const r = await advance(ctx("check_upload_limits"));
    expect(r).toMatchObject({ kind: "continue", notBefore: new Date(now.getTime() + 3_600_000), wait: "Daily limit reached. Docket checks again in an hour; nothing was uploaded." });
    expect(videoOf(r)).toMatchObject({ phase: "limits", limitWaitSince: now.toISOString() });
  });

  it("skips the check on a refusal other than 429, retries a 5xx or 429", async () => {
    pds.route("GET", P.limits, { status: 403, json: { error: "Forbidden" } });
    expect(videoOf(await advance(ctx("check_upload_limits")))).toMatchObject({ phase: "start", limitsCheck: "skipped" });
    for (const script of [{ status: 503, json: {} }, { status: 429, headers: { "retry-after": "30" }, json: {} }] as const) {
      pds.reset();
      pds.route("GET", P.session, { json: {} });
      pds.route("GET", P.auth, { json: { token: "t" } });
      pds.route("GET", P.limits, script);
      expect((await advance(ctx("check_upload_limits"))).kind).toBe("retryable_error");
    }
  });

  it("asks for a refresh when the session is rejected", async () => {
    pds.route("GET", P.auth, { status: 401, json: { error: "AuthenticationRequired" } });
    expect(await advance(ctx("check_upload_limits"))).toMatchObject({ kind: "retryable_error", credentialsExpired: true });
  });
});

describe("start_upload", () => {
  const phase = { phase: "start", restarts: 0, statusAuth: "service", pdsHost: "pds.test" };

  it("posts the exact body with a PDS-audience token and saves the upload", async () => {
    const r = await advance(ctx("start_upload", phase));
    expect(videoOf(r)).toMatchObject({ phase: "parts", url: MEDIA, sizeBytes: SIZE, jobId: "job-1", partSizeBytes: PART, partCount: 3, partsSent: 0 });
    expect(pds.callsTo("POST", P.start)[0]!.body).toEqual({ sizeBytes: SIZE, mimeType: "video/mp4", name: "t1.mp4", durationMs: 30000, width: 1080, height: 1920 });
    const q = new URL(pds.callsTo("GET", P.auth)[0]!.url).searchParams;
    expect([q.get("aud"), q.get("lxm")]).toEqual(["did:web:pds.test", "com.atproto.repo.uploadBlob"]);
    noSecrets(r);
  });

  it("retries when the stored size differs from the record or the reply is unusable", async () => {
    const bad = ctx("start_upload", phase, { content: { text: "x", media: [{ ...item, bytes: SIZE + 1 }] } });
    expect((await advance(bad)).kind).toBe("retryable_error");
    pds.route("POST", P.start, { json: { jobId: "j", partSizeBytes: 1000, partCount: 3, expiresAt: "2026-01-01T01:00:00.000Z" } });
    expect(await advance(ctx("start_upload", phase))).toMatchObject({ kind: "retryable_error", error: expect.stringContaining("unusable") });
  });

  it("retries timeouts, 429 with Retry-After, 5xx and dropped connections", async () => {
    for (const script of [
      { status: 429, headers: { "retry-after": "60" }, json: { error: "RateLimitExceeded" } },
      { status: 503, json: { error: "ServiceOverloaded" } },
      { status: 400, json: { error: "TooManyOpenUploads" } },
      { mode: "reset-mid-body" },
    ] as const) {
      pds.route("POST", P.start, script);
      const r = await advance(ctx("start_upload", phase));
      expect(r.kind).toBe("retryable_error");
      if ("status" in script && script.status === 429) expect(r).toMatchObject({ notBefore: new Date(now.getTime() + 60_000) });
    }
  });

  it("goes straight to ready when Bluesky answers with an already processed blob", async () => {
    pds.route("POST", P.start, { status: 409, json: { error: "AlreadyProcessed", jobStatus: { blob } } });
    expect(videoOf(await advance(ctx("start_upload", phase)))).toMatchObject({ phase: "ready", blob });
  });
});

describe("upload_part_<k>", () => {
  it("sends exactly the part's bytes and advances", async () => {
    const r = await advance(ctx("upload_part_1", upload));
    expect(videoOf(r)).toMatchObject({ phase: "parts", partsSent: 1 });
    const req = pds.callsTo("POST", P.part)[0]!;
    expect(new URL(req.url).searchParams.get("jobId")).toBe("job-1");
    expect(new URL(req.url).searchParams.get("partNumber")).toBe("1");
    expect(req.headers["content-type"]).toBe("application/octet-stream");
    expect((req.body as Uint8Array).length).toBe(PART);
    noSecrets(r);
  });

  it("sends the short last part and moves to finish", async () => {
    const r = await advance(ctx("upload_part_3", { ...upload, partsSent: 2 }));
    expect(videoOf(r)).toMatchObject({ phase: "finish", partsSent: 3 });
    expect((pds.callsTo("POST", P.part)[0]!.body as Uint8Array).length).toBe(2_000_000);
  });

  it("retries the same part on 429, 5xx, a wrong echo and a dropped connection", async () => {
    for (const script of [
      { status: 429, headers: { "retry-after": "10" }, json: {} },
      { status: 502, json: {} },
      { json: { partNumber: 9 } },
      { mode: "reset-mid-body" },
    ] as const) {
      pds.route("POST", P.part, script);
      expect((await advance(ctx("upload_part_1", upload))).kind).toBe("retryable_error");
    }
  });

  it("names the provider time limit when the call is aborted", async () => {
    const ac = new AbortController();
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("uploadPart")) {
        ac.abort();
        throw new DOMException("aborted", "AbortError");
      }
      return inner(input, init);
    }) as typeof fetch);
    expect(await advance(ctx("upload_part_1", upload, { signal: ac.signal }))).toMatchObject({
      kind: "retryable_error",
      error: expect.stringContaining("SCHEDULER_PROVIDER_TIMEOUT_SECONDS"),
    });
  });
});

describe("finish_upload and check_job", () => {
  const finish = { ...upload, phase: "finish", partsSent: 3 };
  const job = { phase: "job", restarts: 0, statusAuth: "service", pollJobId: "job-2", finishedAt: now.toISOString(), reads: 0 };

  it("moves to the job phase, polling the completed job id after 30 s", async () => {
    const r = await advance(ctx("finish_upload", finish));
    expect(videoOf(r)).toMatchObject({ phase: "job", pollJobId: "job-2", reads: 0 });
    expect(r).toMatchObject({ notBefore: new Date(now.getTime() + 30_000) });
    expect(pds.callsTo("POST", P.finish)[0]!.body).toEqual({ jobId: "job-1" });
  });

  it("retries a finish that times out or is rate limited", async () => {
    pds.route("POST", P.finish, { status: 503, json: {} });
    expect((await advance(ctx("finish_upload", finish))).kind).toBe("retryable_error");
  });

  it("saves the blob when the job is done, with the status token's audience", async () => {
    const r = await advance(ctx("check_job", job));
    expect(videoOf(r)).toMatchObject({ phase: "ready", blob });
    expect(pds.callsTo("GET", P.job)[0]!.url).toContain("jobId=job-2");
    expect(pds.callsTo("GET", P.job)[0]!.headers.authorization).toBe("Bearer svc.did:web:video.bsky.app|app.bsky.video.getJobStatus");
  });

  it("keeps waiting at the 1-minute pace while processing", async () => {
    pds.route("GET", P.job, { json: { jobStatus: { state: "JOB_STATE_ENCODING" } } });
    const r = await advance(ctx("check_job", job));
    expect(videoOf(r)).toMatchObject({ phase: "job", reads: 1 });
    expect(r).toMatchObject({ notBefore: new Date(now.getTime() + 60_000) });
  });

  it("retries a 5xx or dropped status read without counting it", async () => {
    for (const script of [{ status: 500, json: {} }, { mode: "pre-send-failure" }] as const) {
      pds.route("GET", P.job, script);
      expect((await advance(ctx("check_job", job))).kind).toBe("retryable_error");
    }
  });
});

describe("create_post with a video", () => {
  it("embeds the blob as returned, with aspect ratio and alt, and no captions", async () => {
    pds.route("POST", P.create, { json: { uri: `at://${DID}/app.bsky.feed.post/3kvid`, cid: CID } });
    const c = ctx("create_post", { phase: "ready", restarts: 0, statusAuth: "service", blob }, { content: { text: "a video", media: [{ ...item, altText: "a dog" }] } });
    const r = await advance(c);
    expect(r).toMatchObject({ kind: "done", url: "https://bsky.app/profile/alice.bsky.social/post/3kvid" });
    const record = (pds.callsTo("POST", P.create)[0]!.body as { record: Record<string, unknown> }).record;
    expect(record.embed).toEqual({ $type: "app.bsky.embed.video", video: blob, aspectRatio: { width: 1080, height: 1920 }, alt: "a dog" });
  });

  it("is ambiguous when the create call times out", async () => {
    pds.route("POST", P.create, { mode: "reset-mid-body" });
    const r = await advance(ctx("create_post", { phase: "ready", restarts: 0, statusAuth: "service", blob }));
    expect(r.kind).toBe("ambiguous");
  });
});

describe("media-range", () => {
  it("reads a 206 of exactly the asked length", async () => {
    const out = await readRange(MEDIA, 10, 19, new AbortController().signal);
    expect(out.bytes.length).toBe(10);
    expect(out.total).toBe(SIZE);
    expect(await storedSize(MEDIA, new AbortController().signal)).toBe(SIZE);
  });

  it("refuses a 200 and a short body", async () => {
    vi.stubGlobal("fetch", (async () => new Response("whole file", { status: 200 })) as typeof fetch);
    await expect(readRange(MEDIA, 0, 3, new AbortController().signal)).rejects.toMatchObject({ kind: "no_ranges" });
    vi.stubGlobal("fetch", (async () => new Response("ab", { status: 206, headers: { "content-range": `bytes 0-3/${SIZE}` } })) as typeof fetch);
    await expect(readRange(MEDIA, 0, 3, new AbortController().signal)).rejects.toMatchObject({ kind: "bad_reply" });
  });
});

describe("failure outcomes (contract §4.2–§4.5, §6)", () => {
  const start = { phase: "start", restarts: 0, statusAuth: "service", pdsHost: "pds.test" };
  const finish = { ...upload, phase: "finish", partsSent: 3 };
  const job = { phase: "job", restarts: 0, statusAuth: "service", pollJobId: "job-2", finishedAt: now.toISOString(), reads: 0 };
  const err = (status: number, error: string, message = "") => ({ status, json: { error, ...(message ? { message } : {}) } });
  const errorOf = (r: StepResult) => (r as { error: string }).error;

  it.each([
    ["UnsupportedContentType", "it is not an MP4 file Bluesky accepts"],
    ["VideoTooLarge", "it is over Bluesky's 300 MB limit"],
    ["VideoTooLong", "it is longer than Bluesky allows"],
    ["BadAspectRatio", "Bluesky does not accept its shape"],
    ["UploadForbidden", "Bluesky does not allow this account to upload video; accounts hosted by Bluesky must verify their email address first"],
  ])("start_upload refuses %s with the contract's text", async (code, explanation) => {
    pds.route("POST", P.start, err(400, code, "nope"));
    const r = await advance(ctx("start_upload", start));
    expect(r.kind).toBe("fatal_error");
    expect(errorOf(r)).toContain(`Bluesky refused the video: ${explanation}`);
    expect(errorOf(r)).toContain(`(${code}: nope). Nothing was published.`);
    noSecrets(r);
  });

  it("start_upload: 401/403 and other 4xx are fatal; DailyLimitExceeded waits; TooManyOpenUploads retries", async () => {
    pds.route("POST", P.start, err(403, "Forbidden"));
    expect(errorOf(await advance(ctx("start_upload", start)))).toBe("Bluesky's video service did not accept Docket's upload credential (Forbidden); nothing was published.");
    pds.route("POST", P.start, err(400, "Weird", "odd"));
    expect(errorOf(await advance(ctx("start_upload", start)))).toBe("Bluesky refused the video upload (Weird: odd); nothing was published.");
    pds.route("POST", P.start, err(400, "DailyLimitExceeded", "Too many today."));
    const wait = await advance(ctx("start_upload", start));
    expect(wait).toMatchObject({ kind: "continue", wait: "Too many today. Docket checks again in an hour; nothing was uploaded." });
    expect(videoOf(wait)).toMatchObject({ phase: "limits" });
    pds.route("POST", P.start, err(400, "TooManyOpenUploads"));
    expect((await advance(ctx("start_upload", start))).kind).toBe("retryable_error");
  });

  it("start_upload: a refused service token is fatal", async () => {
    pds.route("GET", P.auth, err(400, "BadExpiration"));
    expect(errorOf(await advance(ctx("start_upload", start)))).toBe("Bluesky refused to issue a video upload credential (BadExpiration); nothing was published.");
  });

  it("start_upload: a non-2xx answer carrying a processed blob goes straight to ready", async () => {
    pds.route("POST", P.start, { status: 409, json: { error: "already_exists", jobId: "j", state: "JOB_STATE_COMPLETED", blob } });
    expect(videoOf(await advance(ctx("start_upload", start)))).toMatchObject({ phase: "ready", blob });
  });

  it("a part: UploadAlreadyCompleted skips ahead; fatal part codes name the part", async () => {
    pds.route("POST", P.part, err(409, "UploadAlreadyCompleted"));
    expect(videoOf(await advance(ctx("upload_part_1", upload)))).toMatchObject({ phase: "finish", partsSent: 3 });
    for (const code of ["UploadFailed", "InvalidPartNumber"]) {
      pds.route("POST", P.part, err(400, code, "bad"));
      expect(errorOf(await advance(ctx("upload_part_1", upload)))).toBe(`Bluesky refused part 1 of the video (${code}: bad); nothing was published.`);
    }
    pds.route("POST", P.part, err(403, "Forbidden"));
    expect((await advance(ctx("upload_part_1", upload))).kind).toBe("fatal_error");
  });

  it("a part: UploadNotReady retries the same part; restart codes begin again with a counter", async () => {
    pds.route("POST", P.part, err(400, "UploadNotReady"));
    expect((await advance(ctx("upload_part_1", upload))).kind).toBe("retryable_error");
    for (const code of ["UploadNotFound", "UploadAborted", "PartSizeMismatch"]) {
      pds.route("POST", P.part, err(404, code));
      const r = await advance(ctx("upload_part_1", { ...upload, restarts: 1 }));
      expect(r).toMatchObject({ kind: "continue", notBefore: now });
      expect(videoOf(r)).toEqual({ phase: "limits", restarts: 2, statusAuth: "service" });
    }
  });

  it("restarts at most twice, then fails with the expiry or lost-upload text", async () => {
    const expiredUpload = { ...upload, restarts: 2, expiresAt: now.toISOString() };
    expect(errorOf(await advance(ctx("upload_part_1", expiredUpload)))).toBe("Bluesky's upload expired before it finished; nothing was published");
    pds.route("POST", P.part, err(404, "UploadNotFound"));
    expect(errorOf(await advance(ctx("upload_part_1", { ...upload, restarts: 2 })))).toBe("Bluesky lost the upload before it finished (UploadNotFound); nothing was published.");
    const first = await advance(ctx("finish_upload", { ...finish, restarts: 0, expiresAt: now.toISOString() }));
    expect(videoOf(first)).toMatchObject({ phase: "limits", restarts: 1 });
    expect(pds.callsTo("POST", P.finish)).toHaveLength(0);
  });

  it("a part whose stored size changed restarts rather than sending", async () => {
    vi.stubGlobal("fetch", (async () => new Response(Buffer.alloc(PART), { status: 206, headers: { "content-range": `bytes 0-${PART - 1}/${SIZE + 1}` } })) as typeof fetch);
    expect(videoOf(await advance(ctx("upload_part_1", upload)))).toMatchObject({ phase: "limits", restarts: 1 });
  });

  it("a changed post starts again from the first step", async () => {
    const other = { ...upload, url: "https://media.example.test/other.mp4" };
    const r = await advance(ctx("upload_part_1", other));
    expect(r).toMatchObject({ kind: "continue", state: { v: 1 }, notBefore: now });
    expect(pds.requests.filter((q) => q.path === P.part)).toHaveLength(0);
  });

  it("finish_upload: failed job, early blob, restart codes, fatal codes", async () => {
    pds.route("POST", P.finish, { json: { jobStatus: { state: "JOB_STATE_FAILED", failureCode: "encoding_failure", message: "bad" } } });
    expect(errorOf(await advance(ctx("finish_upload", finish)))).toBe("Bluesky could not process the video: Bluesky could not process the file's encoding (encoding_failure: bad). Nothing was published.");
    pds.route("POST", P.finish, { json: { jobStatus: { state: "JOB_STATE_COMPLETED", blob } } });
    expect(videoOf(await advance(ctx("finish_upload", finish)))).toMatchObject({ phase: "ready", blob });
    pds.route("POST", P.finish, { status: 409, json: { error: "x", jobStatus: { blob } } });
    expect(videoOf(await advance(ctx("finish_upload", finish)))).toMatchObject({ phase: "ready" });
    pds.route("POST", P.finish, err(400, "MissingParts"));
    expect(videoOf(await advance(ctx("finish_upload", finish)))).toMatchObject({ phase: "limits", restarts: 1 });
    pds.route("POST", P.finish, err(400, "UnsupportedContentType"));
    expect(errorOf(await advance(ctx("finish_upload", finish)))).toContain("Bluesky refused the video: it is not an MP4 file");
    pds.route("POST", P.finish, err(400, "UploadFailed", "x"));
    expect(errorOf(await advance(ctx("finish_upload", finish)))).toBe("Bluesky could not finish the video upload (UploadFailed: x); nothing was published.");
    pds.route("POST", P.finish, err(400, "UploadNotReady"));
    expect((await advance(ctx("finish_upload", finish))).kind).toBe("retryable_error");
  });

  it("finish_upload: a deduplicated job is polled by its completedJobId", async () => {
    const r = await advance(ctx("finish_upload", finish));
    expect(videoOf(r)).toMatchObject({ pollJobId: "job-2" });
  });

  it("check_job: a failed state beats a blob; each failure code has its text", async () => {
    pds.route("GET", P.job, { json: { jobStatus: { state: "JOB_STATE_FAILED", failureCode: "validation_failure", blob } } });
    expect(errorOf(await advance(ctx("check_job", job)))).toBe("Bluesky could not process the video: Bluesky found the file invalid (validation_failure). Nothing was published.");
    pds.route("GET", P.job, { json: { jobStatus: { state: "JOB_STATE_FAILED", failureCode: "mystery", message: "m" } } });
    expect(errorOf(await advance(ctx("check_job", job)))).toBe("Bluesky could not process the video (mystery: m). Nothing was published.");
    pds.route("GET", P.job, { json: { jobStatus: { state: "JOB_STATE_FAILED" } } });
    expect(errorOf(await advance(ctx("check_job", job)))).toBe("Bluesky could not process the video (no code). Nothing was published.");
  });

  it("check_job: an unknown state or unreadable reply keeps polling and counts a read", async () => {
    pds.route("GET", P.job, { json: { jobStatus: { state: "JOB_STATE_BRAND_NEW" } } });
    expect(videoOf(await advance(ctx("check_job", job)))).toMatchObject({ phase: "job", reads: 1 });
    pds.route("GET", P.job, { json: "not an object" });
    expect(videoOf(await advance(ctx("check_job", job)))).toMatchObject({ phase: "job", reads: 1 });
  });

  it("check_job: fails at the 30-minute ceiling and at the 16th read; paces 5 minutes after 10", async () => {
    pds.route("GET", P.job, { json: { jobStatus: { state: "JOB_STATE_ENCODING" } } });
    const late = new Date(now.getTime() + 30 * 60_000);
    expect(errorOf(await advance(ctx("check_job", job, { now: late })))).toBe("Bluesky did not finish processing the video within 30 minutes; nothing was published");
    expect(errorOf(await advance(ctx("check_job", { ...job, reads: 15 })))).toContain("within 30 minutes");
    const slow = new Date(now.getTime() + 11 * 60_000);
    const r = await advance(ctx("check_job", job, { now: slow }));
    expect(r).toMatchObject({ notBefore: new Date(slow.getTime() + 5 * 60_000) });
  });

  it("check_job: 401 falls back to no auth once, uncounted; a second 401 is fatal; other 4xx fatal", async () => {
    pds.route("GET", P.job, err(401, "AuthRequired"));
    const r = await advance(ctx("check_job", job));
    expect(videoOf(r)).toMatchObject({ phase: "job", statusAuth: "none", reads: 0 });
    pds.route("GET", P.job, (req) => (req.headers.authorization ? err(401, "AuthRequired") : { json: { jobStatus: { state: "JOB_STATE_COMPLETED", blob } } }));
    expect(videoOf(await advance(ctx("check_job", { ...job, statusAuth: "none" })))).toMatchObject({ phase: "ready" });
    pds.route("GET", P.job, err(403, "Forbidden"));
    expect(errorOf(await advance(ctx("check_job", { ...job, statusAuth: "none" })))).toBe("Bluesky refused to report the video's processing status (Forbidden); nothing was published.");
    pds.route("GET", P.job, err(400, "InvalidJobId", "no"));
    expect(errorOf(await advance(ctx("check_job", job)))).toBe("Bluesky refused to report the video's processing status (InvalidJobId: no); nothing was published.");
  });
});
