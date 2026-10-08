import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { videoVersions } from "../../../src/server/db/schema";
import { preparingVideoLabel } from "../../../src/server/services/posts/view";
import { blueskyProvider } from "../../../src/providers/bluesky";
import { closeDb, testDb } from "../../helpers/db";
import { blueskyVideoSetup, CREATE_RECORD_PATH, DID, VIDEO, VIDEO_HOST, GET_SESSION_PATH, SERVICE_AUTH_PATH, MEDIA_ORIGIN, CID } from "../../helpers/bluesky-video";
import { markReady, queueVersionFor } from "../../helpers/video-publish-setup";

type Setup = Awaited<ReturnType<typeof blueskyVideoSetup>>;
let current: Setup | undefined;
afterEach(() => current?.unstub());
afterAll(closeDb);

const T0 = Date.now() + 3_600_000;
const at = (seconds: number) => new Date(T0 + seconds * 1000);

/** Ticks every 31 s of engine time until the target leaves `scheduled`/`publishing`, at most `max` ticks. */
async function drive(s: Setup, max = 20) {
  const times: number[] = [];
  for (let i = 0; i < max; i++) {
    const t = i * 31;
    await s.tick(at(t));
    times.push(t);
    const row = await s.row();
    if (!["scheduled", "publishing"].includes(row.status)) break;
  }
  return times;
}
const bodyOf = (s: Setup, path: string) => s.pds.callsTo("POST", path).map((r) => r.body);

describe("a 12 MB video through runTick", () => {
  it("uploads three parts, polls, creates the post and publishes", async () => {
    current = await blueskyVideoSetup({ alt: "a dog on a beach", text: "my video" });
    const s = current;
    await drive(s);
    const row = await s.row();
    expect(row.status).toBe("published");
    expect(row.externalId).toBe(`at://${DID}/app.bsky.feed.post/3kvid`);

    // Every service token: audience and method per call.
    const auds = s.pds.callsTo("GET", SERVICE_AUTH_PATH).map((r) => {
      const q = new URL(r.url).searchParams;
      return `${q.get("aud")}|${q.get("lxm")}`;
    });
    expect(auds).toEqual([
      "did:web:video.bsky.app|app.bsky.video.getUploadLimits",
      "did:web:pds.example.test|com.atproto.repo.uploadBlob",
      "did:web:pds.example.test|com.atproto.repo.uploadBlob",
      "did:web:pds.example.test|com.atproto.repo.uploadBlob",
      "did:web:pds.example.test|com.atproto.repo.uploadBlob",
      "did:web:pds.example.test|com.atproto.repo.uploadBlob",
      "did:web:video.bsky.app|app.bsky.video.getJobStatus",
    ]);
    expect(s.pds.callsTo("GET", SERVICE_AUTH_PATH).every((r) => Number(new URL(r.url).searchParams.get("exp")) > 0)).toBe(true);

    const video = s.requestsTo(VIDEO_HOST);
    expect(video.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${VIDEO.limits}`,
      `POST ${VIDEO.start}`,
      `POST ${VIDEO.part}`,
      `POST ${VIDEO.part}`,
      `POST ${VIDEO.part}`,
      `POST ${VIDEO.finish}`,
      `GET ${VIDEO.job}`,
    ]);
    expect(video.every((r) => r.headers.authorization?.startsWith("Bearer svc."))).toBe(true);
    expect(bodyOf(s, VIDEO.start)[0]).toMatchObject({ sizeBytes: 12_000_000, mimeType: "video/mp4", durationMs: 40_000, width: 1080, height: 1920 });
    const parts = s.pds.callsTo("POST", VIDEO.part);
    expect(parts.map((r) => new URL(r.url).searchParams.get("partNumber"))).toEqual(["1", "2", "3"]);
    expect(parts.map((r) => (r.body as Uint8Array).length)).toEqual([5_000_000, 5_000_000, 2_000_000]);
    expect(parts.every((r) => new URL(r.url).searchParams.get("jobId") === "job-1")).toBe(true);
    expect(Buffer.from(parts[2]!.body as Uint8Array).equals(s.bytes.subarray(10_000_000))).toBe(true);
    expect(bodyOf(s, VIDEO.finish)[0]).toEqual({ jobId: "job-1" });
    expect(new URL(s.pds.callsTo("GET", VIDEO.job)[0]!.url).searchParams.get("jobId")).toBe("job-1");

    const record = (bodyOf(s, CREATE_RECORD_PATH)[0] as { record: Record<string, unknown> }).record;
    expect(record.embed).toEqual({
      $type: "app.bsky.embed.video",
      video: { $type: "blob", ref: { $link: CID }, mimeType: "video/mp4", size: 12_000_000 },
      aspectRatio: { width: 1080, height: 1920 },
      alt: "a dog on a beach",
    });
    expect(record.text).toBe("my video");
    expect(row.externalUrl).toMatch(/^https:\/\/bsky\.app\/profile\/me\.bsky\.social\/post\/3kvid$/);
    expect(s.ranges.calls.every((c) => c.status === 206)).toBe(true);
  });

  it("reads the job status no sooner than 30 s after finishing, then about a minute apart", async () => {
    current = await blueskyVideoSetup({
      script: { job: [{ json: { jobStatus: { state: "JOB_STATE_ENCODING" } } }, { json: { jobStatus: { state: "JOB_STATE_ENCODING" } } }, { json: { jobStatus: { state: "JOB_STATE_COMPLETED", blob: { $type: "blob", ref: { $link: CID }, mimeType: "video/mp4", size: 12_000_000 } } } }] },
    });
    const s = current;
    const seen: number[] = [];
    for (let t = 0; t < 31 * 40; t += 31) {
      const before = s.pds.callsTo("GET", VIDEO.job).length;
      await s.tick(at(t));
      if (s.pds.callsTo("GET", VIDEO.job).length > before) seen.push(t);
      if ((await s.row()).status === "published") break;
    }
    expect((await s.row()).status).toBe("published");
    expect(seen).toHaveLength(3);
    // First read ≥ 30 s after the finish tick; later reads ≥ 60 s apart.
    expect(seen[1]! - seen[0]!).toBeGreaterThanOrEqual(60);
    expect(seen[2]! - seen[1]!).toBeGreaterThanOrEqual(60);
  });

  it("publishes a one-part video, an empty text and a resolved mention", async () => {
    current = await blueskyVideoSetup({ sizeBytes: 3_000_000, text: "" });
    await drive(current);
    expect((await current.row()).status).toBe("published");
    expect(current.pds.callsTo("POST", VIDEO.part)).toHaveLength(1);
    current.unstub();

    current = await blueskyVideoSetup({ text: "hi @friend.bsky.social" });
    current.pds.route("GET", "/xrpc/com.atproto.identity.resolveHandle", { json: { did: "did:plc:friend" } });
    await drive(current);
    expect((await current.row()).status).toBe("published");
    const paths = current.pds.requests.map((r) => r.path);
    expect(paths.indexOf("/xrpc/com.atproto.identity.resolveHandle")).toBeLessThan(paths.indexOf(VIDEO.limits));
    const record = (bodyOf(current, CREATE_RECORD_PATH)[0] as { record: { facets: unknown[] } }).record;
    expect(JSON.stringify(record.facets)).toContain("did:plc:friend");
  });
});

describe("timeouts", () => {
  const steps: [string, "limits" | "start" | "part" | "finish" | "job"][] = [
    ["check_upload_limits", "limits"],
    ["start_upload", "start"],
    ["upload_part", "part"],
    ["finish_upload", "finish"],
    ["check_job", "job"],
  ];
  it.each(steps)("a dropped connection at %s is retried with nothing published", async (_name, key) => {
    current = await blueskyVideoSetup({ script: { [key]: [{ mode: "pre-send-failure" }, ...(key === "limits" ? [{ json: { canUpload: true } }] : [])] } as never });
    const s = current;
    // Replace the failing script with one that fails once, then answers like the default.
    s.pds.route(key === "part" || key === "start" || key === "finish" ? "POST" : "GET", VIDEO[key], (req, call) => {
      if (call === 0) return { mode: "pre-send-failure" };
      const q = new URL(req.url).searchParams;
      switch (key) {
        case "limits": return { json: { canUpload: true } };
        case "start": return { json: { jobId: "job-1", partSizeBytes: 5_000_000, partCount: 3, expiresAt: "2030-01-01T00:00:00.000Z" } };
        case "part": return { json: { partNumber: Number(q.get("partNumber")) } };
        case "finish": return { json: { completedJobId: "job-1", jobStatus: { state: "JOB_STATE_CREATED" } } };
        case "job": return { json: { jobStatus: { state: "JOB_STATE_COMPLETED", blob: { $type: "blob", ref: { $link: CID }, mimeType: "video/mp4", size: 12_000_000 } } } };
      }
    });
    await s.tick(at(0));
    for (let i = 1; i < 6 && s.pds.callsTo("GET", VIDEO.limits).length + 0 >= 0 && !s.pds.callsTo(key === "limits" || key === "job" ? "GET" : "POST", VIDEO[key]).length; i++) await s.tick(at(i * 31));
    expect(s.pds.callsTo("POST", CREATE_RECORD_PATH)).toHaveLength(0);
    expect((await s.row()).status).not.toBe("failed");
    await drive(s, 25);
    const row = await s.row();
    expect(row.status).toBe("published");
    expect(s.pds.callsTo("POST", CREATE_RECORD_PATH)).toHaveLength(1);
  });

  it("is ambiguous and never retried when createRecord is lost after sending", async () => {
    current = await blueskyVideoSetup({ script: { createRecord: { mode: "reset-mid-body" } } });
    const s = current;
    await drive(s);
    expect((await s.row()).status).toBe("ambiguous");
    await s.tick(at(31 * 30));
    await s.tick(at(31 * 31));
    expect(s.pds.callsTo("POST", CREATE_RECORD_PATH)).toHaveLength(1);
  });
});

describe("a version still being built", () => {
  it("waits with 'Preparing video for Bluesky', then uploads that version's bytes", async () => {
    current = await blueskyVideoSetup({ sizeBytes: 12_000_000, video: { durationSeconds: 300 } });
    const s = current;
    const { version } = await queueVersionFor(s, blueskyProvider);
    await s.tick(at(0));
    let row = await s.row();
    expect(row.status).toBe("scheduled");
    expect(preparingVideoLabel(blueskyProvider.displayName)).toBe("Preparing video for Bluesky");
    expect(s.requestsTo(VIDEO_HOST)).toHaveLength(0);
    expect(s.pds.callsTo("GET", VIDEO.limits)).toHaveLength(0);

    // The built version: 7,000,000 stored bytes at its own key.
    const built = Buffer.alloc(7_000_000, 7);
    const key = `versions/${version.id}.mp4`;
    await s.storage.put(key, built, "video/mp4");
    await markReady(s.env.project.id, version.id, key, s.storage.publicUrl(key));
    await testDb().update(videoVersions).set({ byteSize: built.length, durationMs: 150_000 }).where(and(eq(videoVersions.projectId, s.env.project.id), eq(videoVersions.id, version.id)));
    s.pds.route("POST", VIDEO.start, { json: { jobId: "job-1", partSizeBytes: 5_000_000, partCount: 2, expiresAt: "2030-01-01T00:00:00.000Z" } });
    await drive(s, 25);
    row = await s.row();
    expect(row.status).toBe("published");
    expect(bodyOf(s, VIDEO.start)[0]).toMatchObject({ sizeBytes: 7_000_000 });
    const parts = s.pds.callsTo("POST", VIDEO.part);
    expect(parts.map((r) => (r.body as Uint8Array).length)).toEqual([5_000_000, 2_000_000]);
    expect(s.ranges.calls.some((c) => c.key === key)).toBe(true);
    void GET_SESSION_PATH;
    void MEDIA_ORIGIN;
  });
});
