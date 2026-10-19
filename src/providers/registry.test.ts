import { describe, expect, it } from "vitest";
import { UnknownProviderError } from "./errors";
import { assertVideoCapabilities, mediaConstraintsOf } from "./media";
import { z } from "zod";
import { assertCreationAllowance, assertEngagementDeclaration, assertInsightsDeclaration } from "./registry";
import { readFileSync } from "node:fs";
import { findConnectGroup, findProvider, getProvider, listConnectGroups, listProviders } from "./registry";
import type { EngagementDeclaration, InsightsDeclaration, OAuthConnectGroup } from "./types";

describe("provider registry", () => {
  it("finds the mock provider", () => {
    expect(findProvider("mock")?.key).toBe("mock");
    expect(getProvider("mock").displayName).toBe("Mock (offline)");
  });
  it("returns undefined for an unknown key, and getProvider throws", () => {
    expect(findProvider("nope")).toBeUndefined();
    expect(() => getProvider("nope")).toThrow(UnknownProviderError);
  });
  it("has unique, well-formed keys", () => {
    const keys = listProviders().map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z0-9-]+$/);
  });
  it("gives every custom counting rule a valid name and a zero count for empty text", () => {
    for (const p of listProviders()) {
      const rule = p.capabilities.text.countingRule;
      if (typeof rule === "string") continue;
      expect(rule.name, p.key).toMatch(/^[a-z0-9-]+$/);
      expect(rule.unit, p.key).not.toBe("");
      expect(rule.count(""), p.key).toBe(0);
    }
  });
  it("declares hashtag and mention caps as integers of at least 1", () => {
    for (const p of listProviders()) {
      for (const v of [p.capabilities.text.maxHashtags, p.capabilities.text.maxMentions]) {
        if (v !== undefined) expect(Number.isInteger(v) && v >= 1, p.key).toBe(true);
      }
    }
  });
  it("declares consistent media constraints for every provider", () => {
    for (const p of listProviders()) expect(() => mediaConstraintsOf(p.capabilities), p.key).not.toThrow();
  });
  it("declares Facebook's video choice consistently", () => {
    const caps = getProvider("facebook").capabilities;
    const choice = caps.postTypeChoices?.find((c) => c.shape === "single_video");
    expect(choice?.default).toBe("video");
    for (const o of choice!.options) expect(caps.postTypes).toContain(o.type);
    expect(choice!.options.map((o) => o.type)).toEqual(["video", "reel"]);
    expect(() => assertVideoCapabilities(caps)).not.toThrow();
    expect(caps.video.byPostType?.reel?.maxDurationSeconds).toBe(90);
  });
  it("rejects inconsistent video declarations", () => {
    const base = getProvider("mock").capabilities;
    const bad = (video: typeof base.video, over: Partial<typeof base> = {}) =>
      expect(() => assertVideoCapabilities({ ...base, ...over, video })).toThrow(/Inconsistent video constraints|Inconsistent media constraints/);
    bad({ maxVideos: -1 });
    bad({ maxVideos: 1, minDurationSeconds: 10, maxDurationSeconds: 5 });
    bad({ maxVideos: 1, minWidth: 10, maxWidth: 5 });
    bad({ maxVideos: 1, minAspectRatio: 2, maxAspectRatio: 1 });
    bad({ maxVideos: 1, withImages: true }, { media: { ...base.media, maxImages: 0 } });
    bad({ maxVideos: 1 }, { postTypes: ["text", "image"] });
    expect(() => assertVideoCapabilities({ ...base, video: { maxVideos: 0 } })).not.toThrow();
  });
  it("rejects bad formatter numbers and a recommended shape outside the range", () => {
    const base = getProvider("mock").capabilities;
    const bad = (video: typeof base.video) => expect(() => assertVideoCapabilities({ ...base, video })).toThrow(/Inconsistent video constraints/);
    bad({ maxVideos: 1, maxVideoBitrate: 0 });
    bad({ maxVideos: 1, audioBitrate: -1 });
    bad({ maxVideos: 1, maxAudioSampleRate: Number.POSITIVE_INFINITY });
    bad({ maxVideos: 1, maxAudioChannels: 1.5 });
    bad({ maxVideos: 1, recommendedAspectRatio: Number.NaN });
    bad({ maxVideos: 1, minAspectRatio: 0.5, maxAspectRatio: 2, recommendedAspectRatio: 3 });
    bad({ maxVideos: 1, minAspectRatio: 0.5, maxAspectRatio: 2, byPostType: { reel: { recommendedAspectRatio: 0.4 } } });
    expect(() =>
      assertVideoCapabilities({
        ...base,
        video: { maxVideos: 1, minAspectRatio: 0.5, maxAspectRatio: 2, recommendedAspectRatio: 9 / 16, maxVideoBitrate: 1, maxAudioChannels: 2 },
      }),
    ).not.toThrow();
  });
  it("rejects bad post type choices and per-type limits", () => {
    const base = getProvider("mock").capabilities;
    const opt = (type: "video" | "reel" | "story") => ({ type, label: type, description: type });
    const choice = (over: Record<string, unknown> = {}) => ({
      shape: "single_video" as const,
      options: [opt("video"), opt("reel")],
      default: "video" as const,
      ...over,
    });
    const caps = (postTypeChoices: unknown[], over: Record<string, unknown> = {}) =>
      ({ ...base, postTypes: [...base.postTypes, "reel"], postTypeChoices, ...over }) as typeof base;
    expect(() => assertVideoCapabilities(caps([choice()]))).not.toThrow();
    expect(() => assertVideoCapabilities(caps([choice({ default: "story" })]))).toThrow(/default/);
    expect(() => assertVideoCapabilities(caps([choice({ options: [opt("video")] })]))).toThrow(/at least 2/);
    expect(() => assertVideoCapabilities(caps([choice({ options: [opt("video"), opt("story")] })]))).toThrow(/not in postTypes/);
    expect(() => assertVideoCapabilities(caps([choice({ options: [opt("video"), opt("video")] })]))).toThrow(/duplicate/);
    expect(() => assertVideoCapabilities(caps([choice(), choice()]))).toThrow(/more than one choice/);
    const video = (extra: Record<string, unknown>) => ({ ...base, video: { ...base.video, ...extra } }) as typeof base;
    expect(() => assertVideoCapabilities(video({ byPostType: { nope: {} } }))).toThrow(/not a post type/);
    expect(() => assertVideoCapabilities(video({ byPostType: { reel: { minDurationSeconds: 9, maxDurationSeconds: 3 } } }))).toThrow(/Inconsistent/);
    expect(() => assertVideoCapabilities(video({ minFrameRate: 0 }))).toThrow(/minFrameRate/);
    expect(() => assertVideoCapabilities(video({ minFrameRate: 90, maxFrameRate: 60 }))).toThrow(/minFrameRate/);
    expect(() => assertVideoCapabilities(video({ minFrameRate: 23, byPostType: { reel: { minDurationSeconds: 3 } } }))).not.toThrow();
  });
  it("declares Instagram's single_image choice and its byPostType image overrides", () => {
    const caps = getProvider("instagram").capabilities;
    const choice = caps.postTypeChoices?.find((c) => c.shape === "single_image");
    expect(choice?.default).toBe("image");
    expect(choice?.options.map((o) => o.type)).toEqual(["image", "story"]);
    for (const o of choice!.options) expect(caps.postTypes).toContain(o.type);
    expect(() => mediaConstraintsOf(caps)).not.toThrow();
    const videoChoice = caps.postTypeChoices?.find((c) => c.shape === "single_video");
    expect(videoChoice?.options.map((o) => o.type)).toEqual(["video", "reel", "story"]);
  });
  it("rejects an inconsistent media.byPostType declaration", () => {
    const base = getProvider("instagram").capabilities;
    const media = (byPostType: Record<string, unknown>) => ({ ...base, media: { ...base.media, byPostType } }) as typeof base;
    expect(() => mediaConstraintsOf(media({ nope: {} }))).toThrow(/not a post type/);
    expect(() => mediaConstraintsOf(media({ story: { minAspectRatio: 2, maxAspectRatio: 1 } }))).toThrow(/Inconsistent media constraints/);
    expect(() => mediaConstraintsOf(media({ story: { minAspectRatio: 0.5, maxAspectRatio: 2, recommendedAspectRatio: 3 } }))).toThrow(/recommendedAspectRatio/);
    expect(() => mediaConstraintsOf(media({ story: { minAspectRatio: null, maxAspectRatio: null, recommendedAspectRatio: 9 / 16 } }))).not.toThrow();
  });
  it("rejects a malformed creation allowance", () => {
    const ok = { key: "x", creationAllowance: { count: 50, windowSeconds: 86_400, name: "A" } };
    expect(() => assertCreationAllowance(ok)).not.toThrow();
    expect(() => assertCreationAllowance({ key: "x" })).not.toThrow();
    for (const bad of [{ count: 10 }, { count: 11.5 }, { windowSeconds: 604_801 }, { windowSeconds: 0 }, { name: " " }]) {
      expect(() => assertCreationAllowance({ ...ok, creationAllowance: { ...ok.creationAllowance, ...bad } }), JSON.stringify(bad)).toThrow(/creation allowance/);
    }
  });
  it("accepts a well-formed insights declaration and rejects D1-D6 violations", () => {
    const ok = {
      key: "x",
      capabilities: getProvider("instagram").capabilities,
      insights: {
        declaration: {
          post: [{ key: "likeCount", label: "Likes", shape: { kind: "cumulative" } }],
          account: [{ key: "followersCount", label: "Followers", shape: { kind: "cumulative" } }],
          maxPostsPerRead: 25,
          readBudget: { count: 100, windowSeconds: 3_600 },
        } as InsightsDeclaration,
        postMetricsSchema: z.object({ likeCount: z.number().int().optional() }).strict(),
        accountMetricsSchema: z.object({ followersCount: z.number().int().optional() }).strict(),
        readPostMetrics: async () => ({ kind: "page" as const, entries: [] }),
        readAccountMetrics: async () => ({ kind: "page" as const, metrics: {} }),
      },
    };
    expect(() => assertInsightsDeclaration(ok)).not.toThrow();
    expect(() => assertInsightsDeclaration({ key: "x", capabilities: ok.capabilities })).not.toThrow();
    const withDecl = (over: Partial<typeof ok.insights.declaration>) =>
      assertInsightsDeclaration({ ...ok, insights: { ...ok.insights, declaration: { ...ok.insights.declaration, ...over } } });
    expect(() => withDecl({ post: [], account: [] })).toThrow(/Inconsistent insights declaration/);
    expect(() =>
      withDecl({
        post: [
          { key: "likeCount", label: "Likes", shape: { kind: "cumulative" } },
          { key: "likeCount", label: "Likes", shape: { kind: "cumulative" } },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() => withDecl({ post: [{ key: "likeCount", label: "", shape: { kind: "cumulative" } }] })).toThrow(/label/);
    expect(() => withDecl({ maxPostsPerRead: 0 })).toThrow(/maxPostsPerRead/);
    expect(() => withDecl({ readBudget: { count: 0, windowSeconds: 10 } })).toThrow(/readBudget.count/);
    const unavailableOk = { ...ok, insights: { ...ok.insights, declaration: { post: [], account: [], maxPostsPerRead: 25, readBudget: { count: 1, windowSeconds: 1 }, unavailable: { reason: "needs a permission" } } } };
    expect(() => assertInsightsDeclaration(unavailableOk)).not.toThrow();
    const withSchema = (postMetricsSchema: z.ZodType) => assertInsightsDeclaration({ ...ok, insights: { ...ok.insights, postMetricsSchema } });
    expect(() => withSchema(z.object({ likeCount: z.number().int().optional() }))).toThrow(/closed/);
    expect(() => withSchema(z.object({ likeCount: z.string().optional() }).strict())).toThrow(/optional number/);

    // postScopes non-empty requires a missingPostScopes.reason of 1-300 chars
    expect(() => withDecl({ postScopes: ["read_insights"] })).toThrow(/missingPostScopes/);
    expect(() => withDecl({ postScopes: ["read_insights"], missingPostScopes: { reason: "" } })).toThrow(/missingPostScopes/);
    expect(() => withDecl({ postScopes: ["read_insights"], missingPostScopes: { reason: "x".repeat(301) } })).toThrow(/missingPostScopes/);
    expect(() => withDecl({ postScopes: ["read_insights"], missingPostScopes: { reason: "ok" } })).not.toThrow();

    // accountScopes non-empty requires a missingAccountScopes.reason of 1-300 chars
    expect(() => withDecl({ accountScopes: ["read_insights"] })).toThrow(/missingAccountScopes/);
    expect(() => withDecl({ accountScopes: ["read_insights"], missingAccountScopes: { reason: "" } })).toThrow(/missingAccountScopes/);
    expect(() => withDecl({ accountScopes: ["read_insights"], missingAccountScopes: { reason: "x".repeat(301) } })).toThrow(/missingAccountScopes/);
    expect(() => withDecl({ accountScopes: ["read_insights"], missingAccountScopes: { reason: "ok" } })).not.toThrow();

    // every postScopes/accountScopes entry must match GRANTED_SCOPE_PATTERN
    expect(() => withDecl({ postScopes: ["Not Valid!"], missingPostScopes: { reason: "ok" } })).toThrow(/postScopes/);
    expect(() => withDecl({ accountScopes: ["Not Valid!"], missingAccountScopes: { reason: "ok" } })).toThrow(/accountScopes/);

    // postIdSource: "publicPostId" requires a missingPostId.reason of 1-300 chars
    expect(() => withDecl({ postIdSource: "publicPostId" })).toThrow(/missingPostId/);
    expect(() => withDecl({ postIdSource: "publicPostId", missingPostId: { reason: "" } })).toThrow(/missingPostId/);
    expect(() => withDecl({ postIdSource: "publicPostId", missingPostId: { reason: "ok" } })).not.toThrow();

    // ephemeralPostTypes.postType must be a known PostType, in the provider's own capabilities.postTypes, unique
    expect(() => withDecl({ ephemeralPostTypes: [{ postType: "not-a-post-type" as never, lifetimeMs: 86_400_000 }] })).toThrow(/ephemeralPostTypes/);
    expect(() => withDecl({ ephemeralPostTypes: [{ postType: "text", lifetimeMs: 86_400_000 }] })).toThrow(/ephemeralPostTypes/);
    expect(() =>
      withDecl({
        ephemeralPostTypes: [
          { postType: "story", lifetimeMs: 86_400_000 },
          { postType: "story", lifetimeMs: 86_400_000 },
        ],
      }),
    ).toThrow(/ephemeralPostTypes/);
    expect(() => withDecl({ ephemeralPostTypes: [{ postType: "story", lifetimeMs: 86_400_000 }] })).not.toThrow();

    // ephemeralPostTypes.lifetimeMs must be an integer in [60_000, 30 * 86_400_000]
    expect(() => withDecl({ ephemeralPostTypes: [{ postType: "story", lifetimeMs: 1000 }] })).toThrow(/lifetimeMs/);
    expect(() => withDecl({ ephemeralPostTypes: [{ postType: "story", lifetimeMs: 31 * 86_400_000 }] })).toThrow(/lifetimeMs/);

    // unavailable and postScopes/accountScopes are never both set
    expect(() =>
      withDecl({ post: [], account: [], unavailable: { reason: "no permission" }, postScopes: ["read_insights"], missingPostScopes: { reason: "ok" } }),
    ).toThrow(/unavailable.*postScopes|postScopes.*unavailable/);
  });
  it("accepts a well-formed engagement declaration and rejects G40 violations", () => {
    const ok = { key: "x", engagement: { declaration: { reads: ["comment"], canReply: false } as EngagementDeclaration } };
    expect(() => assertEngagementDeclaration(ok)).not.toThrow();
    expect(() => assertEngagementDeclaration({ key: "x" })).not.toThrow();
    const withDecl = (over: Partial<EngagementDeclaration>) =>
      assertEngagementDeclaration({ ...ok, engagement: { ...ok.engagement, declaration: { ...ok.engagement.declaration, ...over } } });

    expect(() => withDecl({ reads: [] })).toThrow(/reads is empty/);

    expect(() => withDecl({ unavailable: { reason: "" } })).toThrow(/unavailable.reason/);
    expect(() => withDecl({ unavailable: { reason: "x".repeat(301) } })).toThrow(/unavailable.reason/);
    expect(() => withDecl({ unavailable: { reason: "needs a permission" } })).not.toThrow();

    expect(() => withDecl({ unavailable: { reason: "needs a permission" }, readScopes: ["read_comments"] })).toThrow(
      /unavailable and readScopes must never both be set/,
    );

    expect(() => withDecl({ readScopes: ["read_comments"] })).toThrow(/missingReadScopes/);
    expect(() => withDecl({ readScopes: ["read_comments"], missingReadScopes: { reason: "" } })).toThrow(/missingReadScopes/);
    expect(() => withDecl({ readScopes: ["read_comments"], missingReadScopes: { reason: "x".repeat(301) } })).toThrow(/missingReadScopes/);
    expect(() => withDecl({ readScopes: ["read_comments"], missingReadScopes: { reason: "ok" } })).not.toThrow();

    expect(() => withDecl({ readScopes: ["Not Valid!"], missingReadScopes: { reason: "ok" } })).toThrow(/readScopes entry/);

    // A readScope absent from the connect group's requestable scopes fails at load (contracts/meta-comment-surface.md §6 rule 1).
    const group: OAuthConnectGroup = {
      key: "test-group",
      displayName: "Test",
      baseScopes: ["base_scope"],
      optionalScopes: { declared: [{ scope: "optional_scope", purpose: "x" }], requested: () => [] },
      environment: { variables: [], issues: () => [], configured: () => true },
      authorizationUrl: () => "https://example.test",
      exchangeCode: async () => ({ ok: false as const, message: "n/a" }),
    };
    const withGroup = (over: Partial<EngagementDeclaration>) =>
      assertEngagementDeclaration({ key: "x", connect: { strategy: "oauth", group }, engagement: { declaration: { reads: ["comment"], canReply: false, ...over } } });

    expect(() => withGroup({ readScopes: ["base_scope"], missingReadScopes: { reason: "ok" } })).not.toThrow();
    expect(() => withGroup({ readScopes: ["optional_scope"], missingReadScopes: { reason: "ok" } })).not.toThrow();
    expect(() => withGroup({ readScopes: ["unrequestable_scope"], missingReadScopes: { reason: "ok" } })).toThrow(/is not in connect group/);

    // canReply: false forbids a writeBudget on the same declaration.
    expect(() => withDecl({ canReply: false, writeBudget: { count: 1, windowSeconds: 60 } })).toThrow(/writeBudget/);
  });
  it("holds the connect and refresh invariants for every provider", () => {
    for (const p of listProviders()) {
      if (p.connectAccount) {
        expect(["credentials", "manual-token"], p.key).toContain(p.connect.strategy);
        expect(p.connect.strategy === "oauth" ? 0 : p.connect.fields.length, p.key).toBeGreaterThan(0);
      }
      if (p.connect.strategy !== "oauth") {
        const names = p.connect.fields.map((f) => f.name);
        expect(new Set(names).size, p.key).toBe(names.length);
        for (const f of p.connect.fields) {
          expect(f.name, p.key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
          if (f.defaultValue !== undefined) {
            expect(f.optional, `${p.key}.${f.name}`).toBe(true);
            expect(f.secret, `${p.key}.${f.name}`).toBe(false);
          }
        }
      }
      if (p.needsRefresh) expect(p.refreshCredentials, p.key).toBeTypeOf("function");
    }
  });
  it("has a total stepFor on malformed state", () => {
    const content = { text: "", mediaCount: 0 };
    for (const p of listProviders()) {
      const settings = p.settingsSchema.parse({});
      for (const state of [null, undefined, 42, "x", [], {}, { step: "nope" }, { done: "many" }]) {
        const step = p.stepFor(state as never, settings, content);
        expect(step.name, p.key).toBeTypeOf("string");
        expect(step.mayPublish, p.key).toBeTypeOf("boolean");
      }
    }
  });
  describe("connect groups", () => {
    const groups = listConnectGroups();
    it("uses well-formed, unique group keys and one group object per key", () => {
      const keys = groups.map((g) => g.group.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) expect(key).toMatch(/^[a-z0-9-]+$/);
      for (const p of listProviders()) {
        if (p.connect.strategy !== "oauth") continue;
        expect(findConnectGroup(p.connect.group.key)?.group, p.key).toBe(p.connect.group);
      }
    });
    it("gives oauth providers no connectAccount", () => {
      for (const p of listProviders()) {
        if (p.connect.strategy === "oauth") expect(p.connectAccount, p.key).toBeUndefined();
      }
    });
    it("only groups carry pasteToken, and its field is secret", () => {
      for (const p of listProviders()) expect(p.connect, p.key).not.toHaveProperty("pasteToken");
      for (const { group } of groups) {
        if (group.pasteToken) expect(group.pasteToken.field.secret, group.key).toBe(true);
      }
    });
    it("registers threads in its own connect group", () => {
      const entry = findConnectGroup("threads");
      expect(entry?.providers.map((p) => p.key)).toEqual(["threads"]);
      expect(entry?.group.environment.variables.map((v) => v.name)).toEqual([
        "THREADS_APP_ID",
        "THREADS_APP_SECRET",
        "THREADS_GRAPH_BASE",
        "THREADS_INSIGHTS_SCOPES",
        "THREADS_INSIGHTS_USAGE_CEILING",
        "THREADS_ENGAGEMENT_SCOPES",
      ]);
    });
    it("registers x in its own connect group", () => {
      const entry = findConnectGroup("x");
      expect(entry?.providers.map((p) => p.key)).toEqual(["x"]);
      expect(entry?.group.displayName).toBe("X");
      expect(entry?.group.environment.variables.map((v) => [v.name, v.secret])).toEqual([
        ["X_CLIENT_ID", false],
        ["X_CLIENT_SECRET", true],
      ]);
      expect(entry?.group.pasteToken).toBeUndefined();
    });

    it("documents every environment variable in .env.example", () => {
      const example = readFileSync(".env.example", "utf8");
      for (const { group } of groups) {
        for (const v of group.environment.variables) {
          expect(v.name, group.key).toMatch(/^[A-Z][A-Z0-9_]*$/);
          expect(example, `${group.key}: ${v.name}`).toMatch(new RegExp(`^#?\\s*${v.name}=`, "m"));
        }
      }
    });
  });
});
