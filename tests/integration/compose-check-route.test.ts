import { countingRuleName } from "@/providers/text";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as { user: { id: string } } | null }));
vi.mock("@/server/auth/session", () => ({ getSession: async () => session.current }));

import { POST } from "../../src/app/p/[projectSlug]/compose/check/route";
import * as posts from "../../src/server/services/posts";
import { atTime } from "../helpers/clock";
import { closeDb } from "../helpers/db";
import { fakeSession } from "../helpers/auth";
import { createProjectWithMembers } from "../helpers/factories";
import { blueskyProvider } from "../../src/providers/bluesky";
import { blueskyLikeProvider, instagramLikeProvider, registerTestProvider } from "../helpers/provider-fixtures";
import { createMediaAsset, createMockAccount } from "../helpers/scheduling";
import { postsEnv } from "../helpers/posts-env";
import { forProject } from "../../src/server/dal/scope";
import * as accounts from "../../src/server/services/accounts";
import * as slots from "../../src/server/services/slots";

registerTestProvider(blueskyLikeProvider);
registerTestProvider(instagramLikeProvider);
registerTestProvider(blueskyProvider);

afterAll(async () => {
  await closeDb();
});
beforeEach(() => {
  session.current = null;
});

const call = (slug: string, body: unknown, contentType = "application/json") =>
  POST(
    new Request("http://localhost/check", {
      method: "POST",
      headers: { "content-type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectSlug: slug }) },
  );

async function setup() {
  const env = await postsEnv();
  const a = await accounts.saveConnectedAccount(env.scope, {
    providerKey: "bluesky-like",
    externalAccountId: `b-${Math.random().toString(36).slice(2, 8)}`,
    displayName: "Bsky",
    settings: {},
  });
  await slots.addSlot(env.scope, { accountId: a.id, weekday: 1, localTime: "09:00" });
  session.current = fakeSession(env.owner.id);
  return { env, account: a };
}

describe("POST compose/check", () => {
  it("answers a member with counts and no-store", async () => {
    const t = await setup();
    const res = await call(t.env.project.slug, { baseText: "hello", targets: [{ accountId: t.account.id }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.targets[0]).toMatchObject({ accountId: t.account.id, count: 5, canSchedule: true });
  });

  it("is 404 for no session, a non-member, and an unknown account — identically", async () => {
    const t = await setup();
    const stranger = await createProjectWithMembers();
    const bodies = [
      [null, t.env.project.slug, { baseText: "x", targets: [{ accountId: t.account.id }] }],
      [stranger.owner.id, t.env.project.slug, { baseText: "x", targets: [{ accountId: t.account.id }] }],
      [t.env.owner.id, t.env.project.slug, { baseText: "x", targets: [{ accountId: crypto.randomUUID() }] }],
      [t.env.owner.id, "no-such-project", { baseText: "x", targets: [] }],
    ] as const;
    const seen: string[] = [];
    for (const [uid, slug, body] of bodies) {
      session.current = uid ? fakeSession(uid) : null;
      const res = await call(slug, body);
      expect(res.status).toBe(404);
      seen.push(JSON.stringify(await res.json()));
    }
    expect(new Set(seen).size).toBe(1);
  });

  it("rejects non-JSON content types with 415 and bad bodies with 400 fieldErrors", async () => {
    const t = await setup();
    expect((await call(t.env.project.slug, "baseText=x", "application/x-www-form-urlencoded")).status).toBe(415);
    const bad = await call(t.env.project.slug, { baseText: "x", targets: [{ accountId: "nope" }] });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("cache-control")).toBe("no-store");
    const json = await bad.json();
    expect(json).toMatchObject({ ok: false, error: "validation" });
    expect(Object.keys(json.fieldErrors).length).toBeGreaterThan(0);
    expect((await call(t.env.project.slug, "{not json")).status).toBe(400);
  });

  it("counts emoji ZWJ sequences, combining marks and multi-byte text by the provider's rule", async () => {
    const t = await setup();
    const rule = countingRuleName(blueskyLikeProvider.capabilities.text.countingRule) as "graphemes" | "code_points" | "utf8_bytes";
    const family = "👨‍👩‍👧‍👦"; // one grapheme, 7 code points, 25 UTF-8 bytes
    const combined = "é"; // one grapheme, 2 code points
    const text = `${family}${combined}日本`;
    const graphemes = 1 + 1 + 2;
    const codePoints = 7 + 2 + 2;
    const bytes = 25 + 3 + 6;
    const expected = { graphemes, code_points: codePoints, utf8_bytes: bytes }[rule];
    const res = await call(t.env.project.slug, { baseText: text, targets: [{ accountId: t.account.id }] });
    const json = await res.json();
    expect(json.data.targets[0]).toMatchObject({ count: expected, countingRule: rule });
  });

  it("uses an override in place of the base text", async () => {
    const t = await setup();
    const res = await call(t.env.project.slug, {
      baseText: "long base text",
      targets: [{ accountId: t.account.id, overrideText: "hi" }],
    });
    expect((await res.json()).data.targets[0]).toMatchObject({ effectiveText: "hi", count: 2 });
  });

  it("agrees with what addToQueue reports for the same content (SC-002)", async () => {
    const t = await setup();
    const limit = blueskyLikeProvider.capabilities.text.maxLength;
    const over = "a".repeat(limit + 1);
    const json = await (await call(t.env.project.slug, { baseText: over, targets: [{ accountId: t.account.id }] })).json();
    const checked = json.data.targets[0];
    expect(checked.canSchedule).toBe(false);
    const scope = await forProject(fakeSession(t.env.owner.id), t.env.project.slug);
    const draft = await posts.createDraft(scope, { baseText: over, targets: [{ accountId: t.account.id }] });
    const [queued] = await atTime(new Date("2026-10-01T12:00:00Z"), () => posts.addToQueue(scope, draft.post.id));
    expect(queued).toMatchObject({ ok: false, code: "validation" });
    const queuedCodes = (queued as { issues: { code: string }[] }).issues.map((i) => i.code);
    expect(checked.issues.filter((i: { severity: string }) => i.severity === "error").map((i: { code: string }) => i.code)).toEqual(
      queuedCodes,
    );
  });

  describe("a Bluesky target", () => {
    const FAMILY = "👨‍👩‍👧‍👦";
    async function bluesky() {
      const t = await setup();
      const account = await accounts.saveConnectedAccount(t.env.scope, {
        providerKey: "bluesky",
        externalAccountId: `did:plc:${Math.random().toString(36).slice(2, 10)}`,
        displayName: "Real Bsky",
        settings: {},
      });
      return { ...t, bsky: account };
    }
    const check = async (t: Awaited<ReturnType<typeof bluesky>>, body: Record<string, unknown>) => {
      const json = await (await call(t.env.project.slug, { targets: [{ accountId: t.bsky.id }], ...body })).json();
      return json.data.targets[0];
    };

    it("counts graphemes and flags text_too_long at 301", async () => {
      const t = await bluesky();
      const flag = "🇯🇵"; // 1 grapheme, 8 bytes: 300 stay under the byte limit
      const ok = await check(t, { baseText: flag.repeat(300) });
      expect(ok).toMatchObject({ count: 300, limit: 300, countingRule: "graphemes", canSchedule: true });
      const over = await check(t, { baseText: flag.repeat(301) });
      expect(over.count).toBe(301);
      expect(over.canSchedule).toBe(false);
      expect(over.issues).toContainEqual(expect.objectContaining({ code: "text_too_long", severity: "error" }));
    });

    it("blocks text_too_many_bytes in the check and when queueing", async () => {
      const t = await bluesky();
      const text = FAMILY.repeat(121); // 121 graphemes, 3,025 bytes
      const checked = await check(t, { baseText: text });
      expect(checked.canSchedule).toBe(false);
      expect(checked.issues).toContainEqual(
        expect.objectContaining({ code: "text_too_many_bytes", severity: "error", count: 3025, limit: 3000 }),
      );
      const scope = await forProject(fakeSession(t.env.owner.id), t.env.project.slug);
      const draft = await posts.createDraft(scope, { baseText: text, targets: [{ accountId: t.bsky.id }] });
      const [queued] = await atTime(new Date("2026-10-01T12:00:00Z"), () => posts.addToQueue(scope, draft.post.id));
      expect(queued).toMatchObject({ ok: false, code: "validation" });
      expect((queued as { issues: { code: string }[] }).issues.map((i) => i.code)).toContain("text_too_many_bytes");
    });

    it("flags too_many_images at 5", async () => {
      const t = await bluesky();
      const mediaIds = [];
      for (let i = 0; i < 5; i++) mediaIds.push((await createMediaAsset(t.env.project.id, { mimeType: "image/jpeg", altText: "a" })).id);
      const over = await check(t, { baseText: "hi", mediaIds });
      expect(over.canSchedule).toBe(false);
      expect(over.issues).toContainEqual(expect.objectContaining({ code: "too_many_images", count: 5, limit: 4 }));
      const four = await check(t, { baseText: "hi", mediaIds: mediaIds.slice(0, 4) });
      expect(four.issues.map((i: { code: string }) => i.code)).not.toContain("too_many_images");
    });

    it("explains how an oversized or WebP image will be adapted", async () => {
      const t = await bluesky();
      const insert = (mimeType: string, byteSize: number) =>
        t.env.scope.media.insert({
          storageKey: `projects/${t.env.project.id}/media/${crypto.randomUUID()}/original`,
          publicUrl: "https://media.example.test/x",
          mimeType,
          byteSize,
          width: 1200,
          height: 900,
          altText: "a",
        });
      const webp = await insert("image/webp", 50_000);
      const big = await insert("image/jpeg", 3_000_000);
      const res = await check(t, { baseText: "hi", mediaIds: [webp.id, big.id] });
      const notes = res.issues.filter((i: { severity: string }) => i.severity !== "error").map((i: { code: string }) => i.code);
      expect(notes.some((c: string) => c.startsWith("media_will_"))).toBe(true);
      expect(res.issues.filter((i: { code: string }) => i.code === "mime_not_allowed")).toEqual([]);
    });
  });

  describe("Meta targets", () => {
    async function meta() {
      const t = await setup();
      const connect = (providerKey: string, name: string) =>
        accounts.saveConnectedAccount(t.env.scope, {
          providerKey,
          externalAccountId: `${providerKey}-${Math.random().toString(36).slice(2, 8)}`,
          displayName: name,
          settings: {},
        });
      return { ...t, fb: await connect("facebook", "Page"), ig: await connect("instagram", "Gram") };
    }
    type Meta = Awaited<ReturnType<typeof meta>>;
    const checkAll = async (t: Meta, body: Record<string, unknown>) => {
      const json = await (
        await call(t.env.project.slug, { targets: [{ accountId: t.fb.id }, { accountId: t.ig.id }], ...body })
      ).json();
      return json.data.targets as { accountId: string; canSchedule: boolean; issues: { severity: string; code: string }[] }[];
    };

    it("blocks Instagram with exactly one issue when there is no image, and lets Facebook text-only through", async () => {
      const t = await meta();
      const targets = await checkAll(t, { baseText: "hello" });
      const fb = targets.find((x) => x.accountId === t.fb.id)!;
      const ig = targets.find((x) => x.accountId === t.ig.id)!;
      expect(fb.issues.filter((i) => i.severity === "error")).toEqual([]);
      expect(fb.canSchedule).toBe(true);
      expect(ig.issues.filter((i) => i.severity === "error")).toHaveLength(1);
      expect(ig.issues.filter((i) => i.severity === "error")[0]).toMatchObject({ code: "media_required" });
      expect(ig.canSchedule).toBe(false);
    });

    it("lists each provider's own issues per target", async () => {
      const t = await meta();
      const image = await createMediaAsset(t.env.project.id, { mimeType: "image/png", altText: "a" });
      const targets = await checkAll(t, { baseText: "x".repeat(2201), mediaIds: [image.id] });
      const ig = targets.find((x) => x.accountId === t.ig.id)!;
      const fb = targets.find((x) => x.accountId === t.fb.id)!;
      expect(ig.issues.map((i) => i.code)).toContain("text_too_long");
      expect(fb.issues.map((i) => i.code)).not.toContain("text_too_long");
      expect(ig.canSchedule).toBe(false);
      expect(fb.canSchedule).toBe(true);
    });
  });

  describe("requirements summary", () => {
    it("is present with no text and no media, for an Instagram-like target", async () => {
      const t = await setup();
      const insta = await accounts.saveConnectedAccount(t.env.scope, {
        providerKey: "instagram-like",
        externalAccountId: `i-${Math.random().toString(36).slice(2, 8)}`,
        displayName: "Grid",
        settings: {},
      });
      const json = await (await call(t.env.project.slug, { baseText: "", mediaIds: [], targets: [{ accountId: insta.id }] })).json();
      const target = json.data.targets[0];
      const caps = instagramLikeProvider.capabilities;
      expect(target.requirements).toMatchObject({
        text: { maxLength: caps.text.maxLength, countingRule: countingRuleName(caps.text.countingRule) },
        image: {
          maxImages: caps.media.maxImages,
          formats: [{ value: "image/jpeg", label: "JPEG" }],
          convertedTo: { value: "image/jpeg", label: "JPEG" },
          maxBytesPerFile: { value: 8_000_000, label: "8 MB" },
          width: { min: { value: 320, label: "320 px" }, max: { value: 1440, label: "1440 px" } },
          aspectRatio: { min: { value: 0.8, label: "4:5" }, max: { value: 1.91, label: "1.91:1" } },
          maxAltTextLength: 1000,
        },
      });
      expect(target.requirements.image.convertedFrom.map((f: { value: string }) => f.value)).toEqual(["image/png", "image/webp"]);
      expect(target.requirements.video).toMatchObject({ maxVideos: 1, withImages: false });
    });

    it("gives a Bluesky target its own numbers and null for what is not checked", async () => {
      const t = await setup();
      const bsky = await accounts.saveConnectedAccount(t.env.scope, {
        providerKey: "bluesky",
        externalAccountId: `did:plc:${Math.random().toString(36).slice(2, 10)}`,
        displayName: "Real Bsky",
        settings: {},
      });
      const json = await (await call(t.env.project.slug, { baseText: "", targets: [{ accountId: bsky.id }] })).json();
      const r = json.data.targets[0].requirements;
      expect(r.text).toMatchObject({ maxLength: 300, countingRule: "graphemes", unit: "graphemes" });
      expect(r.image.maxImages).toBe(4);
      expect(r.image.formats.map((f: { label: string }) => f.label)).toEqual(["JPEG", "PNG"]);
      expect(r.image.aspectRatio).toEqual({ min: null, max: null });
      expect(r.image.maxAltTextLength).toBeNull();
    });

    it("is null for an account whose provider is not registered", async () => {
      const t = await setup();
      const gone = await createMockAccount(t.env.project.id, {}, { providerKey: "retired-provider" });
      const json = await (await call(t.env.project.slug, { baseText: "", targets: [{ accountId: gone.id }] })).json();
      expect(json.data.targets[0]).toMatchObject({ limit: null, requirements: null });
    });

    it("agrees with limit and countingRule, including over-limit text", async () => {
      const t = await setup();
      for (const baseText of ["", "x".repeat(blueskyLikeProvider.capabilities.text.maxLength + 50)]) {
        const json = await (await call(t.env.project.slug, { baseText, targets: [{ accountId: t.account.id }] })).json();
        const target = json.data.targets[0];
        expect(target.requirements.text.maxLength).toBe(target.limit);
        expect(target.requirements.text.countingRule).toBe(target.countingRule);
      }
    });
  });
});
