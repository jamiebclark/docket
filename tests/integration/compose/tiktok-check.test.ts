import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccountDetailsCache } from "../../../src/server/services/account-details";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";
import { closeDb } from "../../helpers/db";
import { createVideoAsset } from "../../helpers/factories";
import { createFakeTikTok, creatorReply } from "../../helpers/fake-tiktok";
import { postsEnv } from "../../helpers/posts-env";
import { createMediaAsset, parkAllDueTargets } from "../../helpers/scheduling";

const CREATOR = "/v2/post/publish/creator_info/query/";
const fake = createFakeTikTok();

beforeEach(async () => {
  await parkAllDueTargets();
  vi.stubEnv("TIKTOK_CLIENT_KEY", "CLIENT-KEY");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", "CLIENT-SECRET-XYZ");
  vi.stubEnv("TIKTOK_APP_AUDITED", "true");
  clearAccountDetailsCache();
  fake.reset();
  fake.install();
  fake.on("POST", CREATOR, {
    kind: "ok",
    body: creatorReply({ privacy_level_options: ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY"], duet_disabled: true }),
  });
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});
afterAll(closeDb);

async function setup() {
  const env = await postsEnv();
  const account = await accounts.saveConnectedAccount(env.scope, {
    providerKey: "tiktok",
    externalAccountId: `open-${Math.random().toString(36).slice(2, 8)}`,
    displayName: "Ada (@ada)",
    settings: { username: "ada", nickname: "Ada" },
    credentials: {
      v: 1,
      accessToken: "TT-ACCESS-0123456789",
      refreshToken: "TT-REFRESH-0123456789",
      accessExpiresAt: Date.now() + 20 * 3_600_000,
      refreshIssuedAt: Date.now(),
      refreshExpiresAt: Date.now() + 300 * 86_400_000,
      refreshExpiryEstimated: false,
      openId: "open-id-1",
    },
  });
  const video = await createVideoAsset(env.project.id, { width: 1080, height: 1920, durationSeconds: 120 });
  return { env, account, video };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function check(s: Setup, target: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, media: "video" | "photo" = "video") {
  const mediaIds = media === "video" ? [s.video.id] : [(await createMediaAsset(s.env.project.id, { mimeType: "image/jpeg" })).id];
  const result = await posts.checkComposition(s.env.scope, {
    baseText: "hello",
    mediaIds,
    targets: [{ accountId: s.account.id, ...target }],
    ...extra,
  });
  return result.targets[0]!;
}

const errors = (t: Awaited<ReturnType<typeof check>>) => t.issues.filter((i) => i.severity === "error").map((i) => `${i.code}@${i.field}`);

describe("composer check: TikTok posting panel", () => {
  it("shows the heading, three privacy options with none chosen, and Duet disabled with its reason", async () => {
    const t = await check(await setup());
    const panel = t.posting!;
    expect(panel.heading).toBe("Posting to Ada");
    expect(panel.details).toBe("ready");
    expect(panel.notice).toBeNull();
    const p = panel.fields.find((f) => f.key === "privacy")!;
    expect(p).toMatchObject({ kind: "choice", value: null, required: true });
    if (p.kind !== "choice") throw new Error("choice");
    expect(p.options.map((o) => o.label)).toEqual(["Everyone", "Followers", "Only me"]);
    const byKey = new Map(panel.fields.map((f) => [f.key, f]));
    expect(byKey.get("allowDuets")?.disabled?.reason).toBe("Turned off in this TikTok account's settings.");
    expect(byKey.get("allowComments")).toMatchObject({ kind: "toggle", value: false });
    expect(byKey.get("allowStitches")).toMatchObject({ kind: "toggle", value: false });
    expect(byKey.get("allowComments")?.disabled).toBeUndefined();
    expect(panel.afterPreview).toMatch(/few minutes/);
  });

  it("shows only comments (and a photo title) for a photo post", async () => {
    const t = await check(await setup(), {}, {}, "photo");
    const keys = t.posting!.fields.map((f) => f.key);
    expect(keys).toContain("allowComments");
    expect(keys).toContain("photoTitle");
    expect(keys).not.toContain("allowDuets");
    expect(keys).not.toContain("allowStitches");
  });

  it("blocks until privacy and consent are given", async () => {
    const s = await setup();
    const first = await check(s);
    expect(errors(first)).toEqual(expect.arrayContaining(["posting_required@posting"]));
    expect(first.canSchedule).toBe(false);

    const noPrivacy = await check(s, { posting: { allowComments: true } });
    expect(errors(noPrivacy)).toContain("privacy_required@posting.privacy");
    expect(noPrivacy.canSchedule).toBe(false);

    const noConsent = await check(s, { posting: { privacy: "PUBLIC_TO_EVERYONE" } });
    expect(errors(noConsent)).toEqual(["consent_required@consent"]);
    expect(noConsent.posting!.consent).toMatchObject({ agreed: false });
    expect(noConsent.canSchedule).toBe(false);

    const fingerprint = noConsent.posting!.consent!.fingerprint;
    const agreed = await check(s, { posting: { privacy: "PUBLIC_TO_EVERYONE" }, consent: { fingerprint } });
    expect(errors(agreed)).toEqual([]);
    expect(agreed.posting!.consent!.agreed).toBe(true);
    expect(agreed.canSchedule).toBe(true);

    // Any change makes the old agreement stale.
    const changed = await check(s, { posting: { privacy: "FOLLOWER_OF_CREATOR" }, consent: { fingerprint } });
    expect(changed.posting!.consent!.agreed).toBe(false);
    expect(errors(changed)).toEqual(["consent_required@consent"]);
  });

  it("applies the disclosure rule and the disabled interaction rule", async () => {
    const s = await setup();
    const disclosure = await check(s, { posting: { privacy: "PUBLIC_TO_EVERYONE", disclosure: true } });
    expect(errors(disclosure)).toContain("disclosure_incomplete@posting.disclosure");
    const duet = await check(s, { posting: { privacy: "PUBLIC_TO_EVERYONE", allowDuets: true } });
    expect(errors(duet)).toContain("interaction_disabled@posting.allowDuets");
    // The toggle stays operable while on, so the person can clear the error; once off, the error is gone.
    expect(duet.posting!.fields.find((f) => f.key === "allowDuets")!.disabled).toBeUndefined();
    const cleared = await check(s, { posting: { privacy: "PUBLIC_TO_EVERYONE", allowDuets: false } });
    expect(errors(cleared)).not.toContain("interaction_disabled@posting.allowDuets");
    const branded = await check(s, { posting: { privacy: "SELF_ONLY", disclosure: true, brandedContent: true } });
    expect(errors(branded)).toContain("branded_private@posting.privacy");
    const p = branded.posting!.fields.find((f) => f.key === "privacy")!;
    if (p.kind !== "choice") throw new Error("choice");
    expect(p.options.find((o) => o.value === "SELF_ONLY")?.disabled?.reason).toBe("Branded content can't be private.");
  });

  it("reports details_unavailable with a Retry, and consent is not asked for", async () => {
    const s = await setup();
    fake.on("POST", CREATOR, { kind: "http", status: 503 });
    const t = await check(s, { posting: { privacy: "PUBLIC_TO_EVERYONE" } });
    expect(t.posting!.details).toBe("error");
    expect(t.posting!.detailsError).toBe("Couldn't load this TikTok account's options.");
    expect(errors(t)).toEqual(["details_unavailable@posting"]);
    expect(t.canSchedule).toBe(false);

    // Failures are not cached: Retry (fresh) reads again and recovers.
    fake.on("POST", CREATOR, { kind: "ok", body: creatorReply() });
    const retried = await check(s, { posting: { privacy: "PUBLIC_TO_EVERYONE" } }, { refreshDetails: true });
    expect(retried.posting!.details).toBe("ready");
  });

  it("reuses the details for 60 seconds, and Retry reads fresh", async () => {
    const s = await setup();
    await check(s);
    await check(s);
    expect(fake.callsTo("POST", CREATOR)).toHaveLength(1);
    await check(s, {}, { refreshDetails: true });
    expect(fake.callsTo("POST", CREATOR)).toHaveLength(2);
  });

  it("refuses a video longer than the creator's maximum", async () => {
    const s = await setup();
    fake.on("POST", CREATOR, { kind: "ok", body: creatorReply({ max_video_post_duration_sec: 60 }) });
    const t = await check(s, { posting: { privacy: "PUBLIC_TO_EVERYONE" } });
    expect(errors(t)).toContain("creator_duration_exceeded@media.0");
    expect(t.issues.find((i) => i.code === "creator_duration_exceeded")?.message).toBe("This TikTok account can post videos up to 60 seconds.");
  });

  it("is quiet about the unaudited note on an audited install and shows no private note", async () => {
    const t = await check(await setup(), { posting: { privacy: "PUBLIC_TO_EVERYONE" } });
    expect(t.note).toBeNull();
    expect(t.requirements?.notes?.some((n) => /audit/.test(n))).toBe(false);
  });
});
