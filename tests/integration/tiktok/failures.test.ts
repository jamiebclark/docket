import { afterAll, afterEach, describe, expect, it } from "vitest";
import { creatorReply } from "../../helpers/fake-tiktok";
import { closeDb } from "../../helpers/db";
import { CREATOR, STATUS, tiktokVideoSetup, UPLOAD_PATH, UPLOAD_URL, VIDEO_INIT } from "../../helpers/tiktok-publish";

let teardown: (() => void) | undefined;
afterEach(() => teardown?.());
afterAll(closeDb);

type Setup = Awaited<ReturnType<typeof tiktokVideoSetup>>;

const creator = (overrides: Record<string, unknown> = {}) => ({ kind: "ok", body: creatorReply({ privacy_level_options: ["FOLLOWER_OF_CREATOR", "SELF_ONLY"], ...overrides }) }) as const;
const init = { kind: "ok", body: { data: { publish_id: "v_pub_1", upload_url: UPLOAD_URL }, error: { code: "ok" } } } as const;
const complete = { kind: "ok", body: { data: { status: "PUBLISH_COMPLETE" }, error: { code: "ok" } } } as const;
const done = ["published", "failed", "ambiguous"];

const run = async (s: Setup, ticks = 10, stepMs = 120_000) => {
  const base = Date.now();
  for (let i = 0; i < ticks && !done.includes((await s.row()).status); i++) await s.tick(new Date(base + i * stepMs));
};

describe("TikTok: the creator changed since scheduling (D10)", () => {
  const cases: { name: string; opts: Parameters<typeof tiktokVideoSetup>[0]; reply: ReturnType<typeof creator>; says: RegExp }[] = [
    { name: "privacy level no longer offered", opts: {}, reply: creator({ privacy_level_options: ["SELF_ONLY"] }), says: /no longer allows/ },
    { name: "comments turned off", opts: {}, reply: creator({ comment_disabled: true }), says: /turned off comments/ },
    { name: "duets turned off", opts: { values: { allowDuets: true } }, reply: creator({ duet_disabled: true }), says: /turned off duets/ },
    { name: "stitches turned off", opts: { values: { allowStitches: true } }, reply: creator({ stitch_disabled: true }), says: /turned off stitches/ },
    { name: "maximum video length shortened", opts: { durationSeconds: 60 }, reply: creator({ max_video_post_duration_sec: 30 }), says: /up to 30 seconds/ },
    { name: "unaudited app and no private option", opts: { audited: false, values: { privacy: "SELF_ONLY" } }, reply: creator({ privacy_level_options: ["FOLLOWER_OF_CREATOR"] }), says: /only posts? privately|only post privately/ },
  ];

  for (const c of cases) {
    it(`fails with nothing sent: ${c.name}`, async () => {
      const s = await tiktokVideoSetup(c.opts);
      teardown = s.teardown;
      s.fake.on("POST", CREATOR, c.reply).on("POST", VIDEO_INIT, init).on("PUT", UPLOAD_PATH, { kind: "http", status: 201 });

      await run(s);

      const row = await s.row();
      expect(row.status).toBe("failed");
      expect(row.lastError ?? "").toMatch(c.says);
      expect(row.lastError ?? "").toContain("nothing was posted");
      expect(s.fake.callsTo("POST", VIDEO_INIT)).toHaveLength(0);
      expect(s.fake.callsTo("PUT", UPLOAD_PATH)).toHaveLength(0);
    });
  }
});

describe("TikTok: the daily cap", () => {
  it("waits an hour and tries again, then publishes when the cap lifts", async () => {
    const s = await tiktokVideoSetup({ sizeBytes: 3_000_000 });
    teardown = s.teardown;
    s.fake
      .on("POST", CREATOR, [{ kind: "error", code: "spam_risk_too_many_posts", message: "cap" }, creator()])
      .on("POST", VIDEO_INIT, init)
      .on("PUT", UPLOAD_PATH, { kind: "http", status: 201 })
      .on("POST", STATUS, complete);

    const base = Date.now();
    await s.tick(new Date(base));
    const waiting = await s.row();
    expect(waiting.status).not.toBe("failed");
    expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(base + 59 * 60_000);
    expect(s.fake.callsTo("POST", VIDEO_INIT)).toHaveLength(0);

    for (let i = 1; i < 8 && (await s.row()).status !== "published"; i++) await s.tick(new Date(base + 61 * 60_000 + i * 120_000));
    expect((await s.row()).status).toBe("published");
  });

  it("gives up after 23 hours of cap", async () => {
    const s = await tiktokVideoSetup({ sizeBytes: 3_000_000 });
    teardown = s.teardown;
    s.fake.on("POST", CREATOR, { kind: "error", code: "reached_active_user_cap", message: "cap" });

    const base = Date.now();
    for (let h = 0; h <= 25 && !done.includes((await s.row()).status); h++) await s.tick(new Date(base + h * 61 * 60_000));

    const row = await s.row();
    expect(row.status).toBe("failed");
    expect(row.lastError ?? "").toContain("daily posting limit");
    expect(s.fake.callsTo("POST", VIDEO_INIT)).toHaveLength(0);
  });
});

describe("TikTok: every refusal code is explained (§8)", () => {
  const codes: [string, RegExp][] = [
    ["unaudited_client_can_only_post_to_private_accounts", /unaudited app post to a private account/],
    ["url_ownership_unverified", /could not confirm you own the address/],
    ["spam_risk_user_banned_from_posting", /blocked this account/],
    ["invalid_param", /refused the post's settings/],
    ["file_format_check_failed", /could not read the video's format/],
    ["duration_check_failed", /refused the video's length/],
    ["frame_rate_check_failed", /frame rate/],
    ["picture_size_check_failed", /photo's size/],
    ["video_pull_failed", /could not fetch the video/],
    ["photo_pull_failed", /could not fetch the photos/],
    ["publish_cancelled", /cancelled on TikTok/],
    ["auth_removed", /access was removed/],
    ["internal", /internal error/],
    ["some_new_code", /refused the post\./],
  ];

  for (const [code, says] of codes) {
    it(`${code} inside an HTTP 200 body ends the post with TikTok's code attached`, async () => {
      const s = await tiktokVideoSetup({ sizeBytes: 3_000_000 });
      teardown = s.teardown;
      s.fake.on("POST", CREATOR, creator()).on("POST", VIDEO_INIT, { kind: "error", code, message: "detail\nwith  newline", status: 200 });

      await run(s);

      const row = await s.row();
      expect(row.status).toBe("failed");
      expect(row.lastError ?? "").toMatch(says);
      expect(row.lastError ?? "").toContain(`(TikTok: ${code}`);
      expect(row.lastError ?? "").toContain("Nothing was posted");
      expect(s.fake.callsTo("PUT", UPLOAD_PATH)).toHaveLength(0);
    });
  }

  it("a status read's fail_reason is explained too", async () => {
    const s = await tiktokVideoSetup({ sizeBytes: 3_000_000 });
    teardown = s.teardown;
    s.fake
      .on("POST", CREATOR, creator())
      .on("POST", VIDEO_INIT, init)
      .on("PUT", UPLOAD_PATH, { kind: "http", status: 201 })
      .on("POST", STATUS, { kind: "ok", body: { data: { status: "FAILED", fail_reason: "file_format_check_failed" }, error: { code: "ok" } } });

    await run(s);

    const row = await s.row();
    expect(row.status).toBe("failed");
    expect(row.lastError ?? "").toContain("(TikTok: file_format_check_failed");
  });
});

describe("TikTok: slow or refused uploads", () => {
  it("repeats a non-final chunk after a timeout without starting a new upload", async () => {
    const s = await tiktokVideoSetup();
    teardown = s.teardown;
    s.fake
      .on("POST", CREATOR, creator())
      .on("POST", VIDEO_INIT, init)
      .on("PUT", UPLOAD_PATH, [{ kind: "pre_send_failure" }, { kind: "http", status: 206 }, { kind: "http", status: 206 }, { kind: "http", status: 201 }])
      .on("POST", STATUS, complete);

    await run(s, 14);

    const row = await s.row();
    expect(row.status, row.lastError ?? "").toBe("published");
    expect(s.fake.callsTo("POST", VIDEO_INIT)).toHaveLength(1);
    const ranges = s.fake.callsTo("PUT", UPLOAD_PATH).map((p) => p.upload?.contentRange);
    expect(ranges.slice(0, 2)).toEqual(["bytes 0-5242879/20000000", "bytes 0-5242879/20000000"]);
  });

  it("restarts the upload when a repeated chunk is refused", async () => {
    const s = await tiktokVideoSetup();
    teardown = s.teardown;
    s.fake
      .on("POST", CREATOR, creator())
      .on("POST", VIDEO_INIT, init)
      .on("PUT", UPLOAD_PATH, [{ kind: "http", status: 500 }, { kind: "http", status: 400 }, { kind: "http", status: 206 }, { kind: "http", status: 206 }, { kind: "http", status: 201 }])
      .on("POST", STATUS, complete);

    await run(s, 20);

    const row = await s.row();
    expect(row.status, row.lastError ?? "").toBe("published");
    expect(s.fake.callsTo("POST", VIDEO_INIT)).toHaveLength(2);
  });

  it("restarts twice on a 403 and then fails", async () => {
    const s = await tiktokVideoSetup();
    teardown = s.teardown;
    s.fake.on("POST", CREATOR, creator()).on("POST", VIDEO_INIT, init).on("PUT", UPLOAD_PATH, { kind: "http", status: 403 });

    await run(s, 20);

    const row = await s.row();
    expect(row.status).toBe("failed");
    expect(row.lastError ?? "").toContain("upload expired");
    expect(s.fake.callsTo("POST", VIDEO_INIT)).toHaveLength(3);
  });

  it("ends ambiguous when TikTok is still processing after 60 minutes", async () => {
    const s = await tiktokVideoSetup({ sizeBytes: 3_000_000 });
    teardown = s.teardown;
    s.fake
      .on("POST", CREATOR, creator())
      .on("POST", VIDEO_INIT, init)
      .on("PUT", UPLOAD_PATH, { kind: "http", status: 201 })
      .on("POST", STATUS, { kind: "ok", body: { data: { status: "PROCESSING_UPLOAD" }, error: { code: "ok" } } });

    await run(s, 30, 5 * 60_000);

    const row = await s.row();
    expect(row.status).toBe("ambiguous");
    expect(row.lastError ?? "").toContain("60 minutes");
    expect(s.fake.callsTo("POST", VIDEO_INIT)).toHaveLength(1);
    expect(s.fake.callsTo("PUT", UPLOAD_PATH)).toHaveLength(1);
  });
});
