import { afterAll, afterEach, describe, expect, it } from "vitest";
import { creatorReply } from "../../helpers/fake-tiktok";
import { closeDb } from "../../helpers/db";
import { CREATOR, STATUS, tiktokVideoSetup, UPLOAD_PATH, UPLOAD_URL, VIDEO_INIT } from "../../helpers/tiktok-publish";

let teardown: (() => void) | undefined;
afterEach(() => teardown?.());
afterAll(closeDb);

const creator = { kind: "ok", body: creatorReply({ privacy_level_options: ["FOLLOWER_OF_CREATOR", "SELF_ONLY"] }) } as const;
const init = { kind: "ok", body: { data: { publish_id: "v_pub_1", upload_url: UPLOAD_URL }, error: { code: "ok" } } } as const;
const complete = { kind: "ok", body: { data: { status: "PUBLISH_COMPLETE" }, error: { code: "ok" } } } as const;

describe("TikTok video publishing", () => {
  it("sends three chunks by byte range and finishes with the publish id", async () => {
    const s = await tiktokVideoSetup();
    teardown = s.teardown;
    s.fake.on("POST", CREATOR, creator).on("POST", VIDEO_INIT, init).on("PUT", UPLOAD_PATH, [{ kind: "http", status: 206 }, { kind: "http", status: 206 }, { kind: "http", status: 201 }]).on("POST", STATUS, complete);

    for (let i = 0; i < 6 && (await s.row()).status !== "published"; i++) await s.tick(new Date(Date.now() + i * 120_000));

    const row = await s.row();
    expect(row.status, row.lastError ?? "").toBe("published");
    expect(row.externalId).toBe("v_pub_1");
    const [start] = s.fake.callsTo("POST", VIDEO_INIT);
    expect(s.fake.callsTo("POST", VIDEO_INIT)).toHaveLength(1);
    expect(start!.fields.source_info).toEqual({ source: "FILE_UPLOAD", video_size: 20_000_000, chunk_size: 5_242_880, total_chunk_count: 3 });
    expect(start!.fields.post_info).toMatchObject({ privacy_level: "FOLLOWER_OF_CREATOR", disable_comment: false });
    const puts = s.fake.callsTo("PUT", UPLOAD_PATH);
    expect(puts.map((p) => p.upload?.contentRange)).toEqual(["bytes 0-5242879/20000000", "bytes 5242880-10485759/20000000", "bytes 10485760-19999999/20000000"]);
    expect(puts.map((p) => p.upload?.bytes)).toEqual([5_242_880, 5_242_880, 9_514_240]);
    // Never the whole file in one read.
    expect(s.ranges.calls.every((c) => c.status === 206)).toBe(true);
    expect(JSON.stringify(row)).not.toContain("SIGSECRET");
  });

  it("a video under 5 MB goes in one chunk", async () => {
    const s = await tiktokVideoSetup({ sizeBytes: 3_000_000 });
    teardown = s.teardown;
    s.fake.on("POST", CREATOR, creator).on("POST", VIDEO_INIT, init).on("PUT", UPLOAD_PATH, { kind: "http", status: 201 }).on("POST", STATUS, complete);

    for (let i = 0; i < 6 && (await s.row()).status !== "published"; i++) await s.tick(new Date(Date.now() + i * 120_000));

    expect((await s.row()).status).toBe("published");
    expect(s.fake.callsTo("POST", VIDEO_INIT)[0]!.fields.source_info).toMatchObject({ video_size: 3_000_000, chunk_size: 3_000_000, total_chunk_count: 1 });
    expect(s.fake.callsTo("PUT", UPLOAD_PATH)).toHaveLength(1);
  });

  it("makes no second publishing request after the last chunk", async () => {
    const s = await tiktokVideoSetup();
    teardown = s.teardown;
    s.fake.on("POST", CREATOR, creator).on("POST", VIDEO_INIT, init).on("PUT", UPLOAD_PATH, [{ kind: "http", status: 206 }, { kind: "http", status: 206 }, { kind: "http", status: 201 }])
      .on("POST", STATUS, { kind: "ok", body: { data: { status: "PROCESSING_UPLOAD" }, error: { code: "ok" } } });

    for (let i = 0; i < 8; i++) await s.tick(new Date(Date.now() + i * 20_000));

    expect((await s.row()).status).not.toBe("failed");
    expect(s.fake.callsTo("POST", VIDEO_INIT)).toHaveLength(1);
    expect(s.fake.callsTo("PUT", UPLOAD_PATH).length).toBeLessThanOrEqual(3);
  });
});
