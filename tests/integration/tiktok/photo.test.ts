import { afterAll, afterEach, describe, expect, it } from "vitest";
import { creatorReply } from "../../helpers/fake-tiktok";
import { closeDb } from "../../helpers/db";
import { CREATOR, PHOTO_INIT, STATUS, tiktokVideoSetup } from "../../helpers/tiktok-publish";

let teardown: (() => void) | undefined;
afterEach(() => teardown?.());
afterAll(closeDb);

const creator = { kind: "ok", body: creatorReply({ privacy_level_options: ["SELF_ONLY"] }) } as const;
const accepted = { kind: "ok", body: { data: { publish_id: "p_pub_1" }, error: { code: "ok" } } } as const;
const status = (s: string) => ({ kind: "ok", body: { data: { status: s }, error: { code: "ok" } } }) as const;
const jpg = { format: "jpeg", width: 800, height: 600 } as const;
const values = { privacy: "SELF_ONLY", photoTitle: "Trip" };

const run = async (s: Awaited<ReturnType<typeof tiktokVideoSetup>>, ticks = 8) => {
  for (let i = 0; i < ticks && !["published", "failed", "ambiguous"].includes((await s.row()).status); i++) await s.tick(new Date(Date.now() + i * 120_000));
};

describe("TikTok photo publishing", () => {
  it("checks the creator, posts PHOTO / DIRECT_POST, waits through PROCESSING_DOWNLOAD and finishes", async () => {
    const s = await tiktokVideoSetup({ photos: [jpg, jpg, jpg], values, text: "three photos" });
    teardown = s.teardown;
    s.fake.on("POST", CREATOR, creator).on("POST", PHOTO_INIT, accepted).on("POST", STATUS, [status("PROCESSING_DOWNLOAD"), status("PUBLISH_COMPLETE")]);

    await run(s);

    const row = await s.row();
    expect(row.status, row.lastError ?? "").toBe("published");
    expect(row.externalId).toBe("p_pub_1");
    const inits = s.fake.callsTo("POST", PHOTO_INIT);
    expect(inits).toHaveLength(1);
    const f = inits[0]!.fields as { media_type: string; post_mode: string; source_info: { source: string; photo_images: string[]; photo_cover_index: number }; post_info: Record<string, unknown> };
    expect(f).toMatchObject({ media_type: "PHOTO", post_mode: "DIRECT_POST", source_info: { source: "PULL_FROM_URL", photo_cover_index: 0 } });
    expect(f.source_info.photo_images).toHaveLength(3);
    expect(f.source_info.photo_images.every((u) => u.startsWith("https://"))).toBe(true);
    expect(f.post_info).toMatchObject({ privacy_level: "SELF_ONLY", title: "Trip", description: "three photos" });
    expect(s.fake.callsTo("POST", STATUS).length).toBeGreaterThanOrEqual(2);
  });

  it("sends a JPEG derivative for a PNG and for an image wider than 1080 px", async () => {
    const s = await tiktokVideoSetup({ photos: [{ format: "png", width: 600, height: 400 }, { format: "jpeg", width: 2400, height: 1200 }], values });
    teardown = s.teardown;
    s.fake.on("POST", CREATOR, creator).on("POST", PHOTO_INIT, accepted).on("POST", STATUS, status("PUBLISH_COMPLETE"));

    await run(s);

    const urls = (s.fake.callsTo("POST", PHOTO_INIT)[0]!.fields as { source_info: { photo_images: string[] } }).source_info.photo_images;
    expect(urls).toHaveLength(2);
    for (const u of urls) {
      expect(u).toMatch(/\/v\/[^/]+\.jpg$/);
      expect(u).not.toMatch(/original/);
    }
  });

  it("surfaces url_ownership_unverified as a plain failure", async () => {
    const s = await tiktokVideoSetup({ photos: [jpg], values });
    teardown = s.teardown;
    s.fake.on("POST", CREATOR, creator).on("POST", PHOTO_INIT, { kind: "http", status: 400, body: JSON.stringify({ error: { code: "url_ownership_unverified", message: "verify" } }) });

    await run(s);

    const row = await s.row();
    expect(row.status).toBe("failed");
    expect(row.lastError).toContain("Nothing was posted");
  });

  it("treats a timeout after the init request as ambiguous and never re-sends it", async () => {
    const s = await tiktokVideoSetup({ photos: [jpg], values });
    teardown = s.teardown;
    s.fake.on("POST", CREATOR, creator).on("POST", PHOTO_INIT, { kind: "network", phase: "lost" } as never);

    await run(s);

    expect((await s.row()).status).toBe("ambiguous");
    expect(s.fake.callsTo("POST", PHOTO_INIT)).toHaveLength(1);
  });

  it("reports photo_pull_failed from the status read as a failure", async () => {
    const s = await tiktokVideoSetup({ photos: [jpg], values });
    teardown = s.teardown;
    s.fake.on("POST", CREATOR, creator).on("POST", PHOTO_INIT, accepted).on("POST", STATUS, { kind: "ok", body: { data: { status: "FAILED", fail_reason: "photo_pull_failed" }, error: { code: "ok" } } });

    await run(s);

    const row = await s.row();
    expect(row.status).toBe("failed");
    expect(row.lastError ?? "").not.toBe("");
  });
});
