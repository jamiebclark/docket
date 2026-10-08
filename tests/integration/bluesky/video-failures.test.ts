import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { publishAttempts } from "../../../src/server/db/schema/attempts";
import { mediaAssets } from "../../../src/server/db/schema/media";
import { blueskyVideoSetup, CREATE_RECORD_PATH, CID, VIDEO } from "../../helpers/bluesky-video";
import { closeDb, testDb } from "../../helpers/db";
import { createVideoAsset } from "../../helpers/factories";

type Setup = Awaited<ReturnType<typeof blueskyVideoSetup>>;
let current: Setup | undefined;
afterEach(() => current?.unstub());
afterAll(closeDb);

const T0 = Date.now() + 3_600_000;
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const blob = { $type: "blob", ref: { $link: CID }, mimeType: "video/mp4", size: 12_000_000 };
const err = (status: number, error: string, message = "nope") => ({ status, json: { error, message } });

/** Ticks every `every` seconds of engine time until the target leaves scheduled/publishing; returns the tick times. */
async function drive(s: Setup, max = 60, every = 31): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < max; i++) {
    times.push(i * every);
    await s.tick(at(i * every));
    if (!["scheduled", "publishing"].includes((await s.row()).status)) break;
  }
  return times;
}
const posted = (s: Setup, path: string) => s.pds.callsTo("POST", path);
const partNumbers = (s: Setup) => posted(s, VIDEO.part).map((r) => Number(new URL(r.url).searchParams.get("partNumber")));

describe("a refusal ends the post with a plain message", () => {
  it.each([
    ["UnsupportedContentType", "it is not an MP4 file Bluesky accepts"],
    ["VideoTooLarge", "it is over Bluesky's 300 MB limit"],
    ["VideoTooLong", "it is longer than Bluesky allows"],
    ["BadAspectRatio", "Bluesky does not accept its shape"],
    ["UploadForbidden", "must verify their email address first"],
  ])("start refusal %s", async (code, explanation) => {
    current = await blueskyVideoSetup({ script: { start: err(400, code) } });
    await drive(current);
    const row = await current.row();
    expect(row.status).toBe("failed");
    expect(row.lastError).toContain(`Bluesky refused the video: `);
    expect(row.lastError).toContain(explanation);
    expect(row.lastError).toContain(`(${code}: nope). Nothing was published.`);
    expect(posted(current, VIDEO.part)).toHaveLength(0);
    expect(posted(current, CREATE_RECORD_PATH)).toHaveLength(0);
  });

  it.each([
    ["validation_failure", "Bluesky found the file invalid (validation_failure: nope)"],
    ["encoding_failure", "Bluesky could not process the file's encoding (encoding_failure: nope)"],
    ["pds_upload_failure", "try again later (pds_upload_failure: nope)"],
    ["pds_upload_unsupported_blob_size", "common on self-hosted servers"],
    ["generic_failure", "Bluesky could not process the video (generic_failure: nope)"],
    ["something_new", "Bluesky could not process the video (something_new: nope). Nothing was published."],
  ])("job failure %s", async (failureCode, text) => {
    current = await blueskyVideoSetup({ script: { job: { json: { jobStatus: { state: "JOB_STATE_FAILED", failureCode, message: "nope", blob } } } } });
    await drive(current);
    const row = await current.row();
    expect(row.status).toBe("failed");
    expect(row.lastError).toContain(text);
    expect(posted(current, CREATE_RECORD_PATH)).toHaveLength(0);
  });
});

describe("a slow job", () => {
  it("keeps polling through an unknown state and an unreadable reply", async () => {
    current = await blueskyVideoSetup({ script: { job: [{ json: { jobStatus: { state: "JOB_STATE_WEIRD" } } }, { json: "junk" }, { json: { jobStatus: { state: "JOB_STATE_COMPLETED", blob } } }] } });
    await drive(current, 80);
    expect((await current.row()).status).toBe("published");
    expect(current.pds.callsTo("GET", VIDEO.job)).toHaveLength(3);
  });

  it("records a numeric progress from a check_job read", async () => {
    current = await blueskyVideoSetup({ script: { job: [{ json: { jobStatus: { state: "JOB_STATE_ENCODING", progress: 42 } } }, { json: { jobStatus: { state: "JOB_STATE_COMPLETED", blob } } }] } });
    await drive(current, 80);
    const attempts = await testDb().select().from(publishAttempts).where(eq(publishAttempts.projectId, current.env.project.id));
    expect(JSON.stringify(attempts)).toContain('"progress":42');
  });

  it("fails after 30 minutes or 16 reads, at the 5-minute pace once 10 minutes have passed", async () => {
    current = await blueskyVideoSetup({ script: { job: { json: { jobStatus: { state: "JOB_STATE_ENCODING" } } } } });
    const s = current;
    const reads: number[] = [];
    let finishedAt: number | undefined;
    for (let t = 0; t < 60 * 60; t += 31) {
      const jobs = s.pds.callsTo("GET", VIDEO.job).length;
      const finishes = posted(s, VIDEO.finish).length;
      await s.tick(at(t));
      if (finishedAt === undefined && posted(s, VIDEO.finish).length > finishes) finishedAt = t;
      if (s.pds.callsTo("GET", VIDEO.job).length > jobs) reads.push(t);
      if (!["scheduled", "publishing"].includes((await s.row()).status)) break;
    }
    const row = await s.row();
    expect(row.status).toBe("failed");
    expect(row.lastError).toBe("Bluesky did not finish processing the video within 30 minutes; nothing was published");
    expect(reads.length).toBeLessThanOrEqual(16);
    expect(reads[reads.length - 1]! - finishedAt!).toBeLessThanOrEqual(35 * 60);
    const late = reads.filter((t) => t - finishedAt! > 10 * 60);
    for (let i = 1; i < late.length; i++) expect(late[i]! - late[i - 1]!).toBeGreaterThanOrEqual(300);
    expect(posted(s, CREATE_RECORD_PATH)).toHaveLength(0);
  });

  it("polls a deduplicated finish by its completedJobId", async () => {
    current = await blueskyVideoSetup({ script: { finish: { json: { completedJobId: "job-9", jobStatus: { state: "JOB_STATE_CREATED" } } } } });
    await drive(current);
    expect((await current.row()).status).toBe("published");
    expect(new URL(current.pds.callsTo("GET", VIDEO.job)[0]!.url).searchParams.get("jobId")).toBe("job-9");
  });

  it("skips polling when a finish answers with an already processed blob", async () => {
    current = await blueskyVideoSetup({ script: { finish: { status: 409, json: { error: "already_exists", jobStatus: { state: "JOB_STATE_COMPLETED", blob } } } } });
    await drive(current);
    expect((await current.row()).status).toBe("published");
    expect(current.pds.callsTo("GET", VIDEO.job)).toHaveLength(0);
  });

  it("falls back to an unauthenticated status read when the service token is refused", async () => {
    current = await blueskyVideoSetup({
      script: { job: (req) => (req.headers.authorization ? err(401, "AuthRequired") : { json: { jobStatus: { state: "JOB_STATE_COMPLETED", blob } } }) },
    });
    await drive(current);
    expect((await current.row()).status).toBe("published");
    const jobs = current.pds.callsTo("GET", VIDEO.job);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.headers.authorization).toBeTruthy();
    expect(jobs[1]!.headers.authorization).toBeUndefined();
  });
});

describe("an expired or interrupted upload", () => {
  it("restarts twice, then fails with the expiry text", async () => {
    current = await blueskyVideoSetup({
      script: { start: { json: { jobId: "job-1", partSizeBytes: 5_000_000, partCount: 3, expiresAt: at(0).toISOString() } } },
    });
    await drive(current);
    const row = await current.row();
    expect(row.status).toBe("failed");
    expect(row.lastError).toBe("Bluesky's upload expired before it finished; nothing was published");
    expect(posted(current, VIDEO.start)).toHaveLength(3);
    expect(posted(current, VIDEO.part)).toHaveLength(0);
  });

  it("resends the same part number after a dropped connection", async () => {
    current = await blueskyVideoSetup();
    current.pds.route("POST", VIDEO.part, (req, call) => {
      const n = Number(new URL(req.url).searchParams.get("partNumber"));
      return n === 2 && call === 1 ? { mode: "pre-send-failure" } : { json: { partNumber: n } };
    });
    await drive(current, 80);
    expect((await current.row()).status).toBe("published");
    expect(partNumbers(current)).toEqual([1, 2, 2, 3]);
    expect(posted(current, CREATE_RECORD_PATH)).toHaveLength(1);
  });

  it("resumes at its step after a worker dies mid-part, and creates the post once", async () => {
    current = await blueskyVideoSetup();
    current.pds.route("POST", VIDEO.part, (req, call) => {
      const n = Number(new URL(req.url).searchParams.get("partNumber"));
      return n === 2 && call === 1 ? { mode: "reset-mid-body" } : { json: { partNumber: n } };
    });
    await drive(current, 80);
    expect((await current.row()).status).toBe("published");
    expect(partNumbers(current)).toEqual([1, 2, 2, 3]);
    expect(posted(current, VIDEO.start)).toHaveLength(1);
    expect(posted(current, CREATE_RECORD_PATH)).toHaveLength(1);
  });

  it("starts again when the post's video changes mid-upload", async () => {
    current = await blueskyVideoSetup();
    const s = current;
    s.pds.route("POST", VIDEO.start, (req) => {
      const size = (req.body as { sizeBytes: number }).sizeBytes;
      return { json: { jobId: "job-1", partSizeBytes: 5_000_000, partCount: Math.ceil(size / 5_000_000), expiresAt: "2030-01-01T00:00:00.000Z" } };
    });
    for (let i = 0; i < 3; i++) await s.tick(at(i * 31));
    expect(posted(s, VIDEO.start)).toHaveLength(1);

    const other = await createVideoAsset(s.env.project.id, { width: 1080, height: 1920, durationSeconds: 40, byteSize: 6_000_000 });
    await s.storage.put(other.storageKey, Buffer.alloc(6_000_000, 3), "video/mp4");
    await testDb().update(mediaAssets).set({ publicUrl: s.storage.publicUrl(other.storageKey) }).where(and(eq(mediaAssets.projectId, s.env.project.id), eq(mediaAssets.id, other.id)));
    await s.repos.posts.setMedia(s.post.id, [other.id]);

    for (let i = 3; i < 60; i++) {
      await s.tick(at(i * 31));
      if (!["scheduled", "publishing"].includes((await s.row()).status)) break;
    }
    expect((await s.row()).status).toBe("published");
    expect(posted(s, VIDEO.start)).toHaveLength(2);
    expect((posted(s, VIDEO.start)[1]!.body as { sizeBytes: number }).sizeBytes).toBe(6_000_000);
  });
});
