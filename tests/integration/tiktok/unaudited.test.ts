import { afterAll, afterEach, describe, expect, it } from "vitest";
import { creatorReply } from "../../helpers/fake-tiktok";
import { closeDb } from "../../helpers/db";
import { CREATOR, STATUS, tiktokVideoSetup, UPLOAD_PATH, UPLOAD_URL, VIDEO_INIT } from "../../helpers/tiktok-publish";

let teardown: (() => void) | undefined;
afterEach(() => teardown?.());
afterAll(closeDb);

const init = { kind: "ok", body: { data: { publish_id: "v_pub_1", upload_url: UPLOAD_URL }, error: { code: "ok" } } } as const;
const complete = { kind: "ok", body: { data: { status: "PUBLISH_COMPLETE" }, error: { code: "ok" } } } as const;
const allOptions = { kind: "ok", body: creatorReply({ privacy_level_options: ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY"] }) } as const;

describe("unaudited TikTok app", () => {
  it("sends SELF_ONLY whatever options the creator offers", async () => {
    const s = await tiktokVideoSetup({ audited: false, values: { privacy: "SELF_ONLY" } });
    teardown = s.teardown;
    s.fake.on("POST", CREATOR, allOptions).on("POST", VIDEO_INIT, init).on("PUT", UPLOAD_PATH, [{ kind: "http", status: 206 }, { kind: "http", status: 206 }, { kind: "http", status: 201 }]).on("POST", STATUS, complete);

    for (let i = 0; i < 6 && (await s.row()).status !== "published"; i++) await s.tick(new Date(Date.now() + i * 120_000));

    expect((await s.row()).status).toBe("published");
    expect(s.fake.callsTo("POST", VIDEO_INIT)[0]!.fields.post_info).toMatchObject({ privacy_level: "SELF_ONLY" });
  });

  it("fails at publish, posting nothing, when a non-private choice meets an unaudited app", async () => {
    // Scheduled while audited (public values), then the install flips to unaudited.
    const s = await tiktokVideoSetup({ audited: false, values: { privacy: "PUBLIC_TO_EVERYONE" } });
    teardown = s.teardown;
    s.fake.on("POST", CREATOR, allOptions).on("POST", VIDEO_INIT, init);

    for (let i = 0; i < 3; i++) await s.tick(new Date(Date.now() + i * 120_000));

    const row = await s.row();
    expect(row.status).toBe("failed");
    expect(row.lastError).toMatch(/not audited, so it can only post privately/);
    expect(s.fake.callsTo("POST", VIDEO_INIT)).toHaveLength(0);
  });
});
