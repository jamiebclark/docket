import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { runCrossProject } from "../../../../src/server/db/cross-project";
import { apiKeys, member } from "../../../../src/server/db/schema";
import { api, createKey, world } from "../../../helpers/api";
import { closeDb, testDb } from "../../../helpers/db";

afterAll(closeDb);

const uniq = () => Math.random().toString(36).slice(2, 10);

const fullBody = (slug = `p-${uniq()}`) => ({
  name: `Up Next ${slug}`,
  slug,
  timezone: "America/New_York",
  defaultApprovalPolicy: "review_required",
  defaultSchedulingPolicy: "add_to_queue",
  confirmUnreviewedQueue: true,
  tagline: "Board games, explained in a minute.",
  description: "Short, friendly explainers for modern board games.",
  websiteUrl: "https://playupnext.live",
});

describe("POST /projects", () => {
  it("creates a project with all nine fields, the key's creator as owner, and the response shape", async () => {
    const w = await world();
    const key = w.a.keys.manageSetup.secret;
    const body = fullBody();
    const r = await api("POST", "/projects", { key, body });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({
      id: expect.any(String),
      slug: body.slug,
      name: body.name,
      timezone: body.timezone,
      defaultApprovalPolicy: "review_required",
      defaultSchedulingPolicy: "add_to_queue",
      tagline: body.tagline,
      description: body.description,
      websiteUrl: body.websiteUrl,
    });
    await runCrossProject("test", async () => {
      const rows = await testDb().select().from(member).where(eq(member.organizationId, r.json.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userId: w.a.owner.id, role: "owner" });
    });
  });

  it("answers 403 for a key lacking manage_setup", async () => {
    const w = await world();
    const r = await api("POST", "/projects", { key: w.a.keys.read.secret, body: fullBody() });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("missing_permission");
    expect(r.json.error.details).toEqual({ permission: "manage_setup" });
  });

  it("answers an identical 409 slug_taken whether the holder is visible or invisible to the caller", async () => {
    const w = await world();
    const slug = `p-${uniq()}`;
    await api("POST", "/projects", { key: w.a.keys.manageSetup.secret, body: fullBody(slug) });
    const visible = await api("POST", "/projects", { key: w.a.keys.manageSetup.secret, body: fullBody(slug) });
    const invisible = await api("POST", "/projects", { key: w.b.keys.manageSetup.secret, body: fullBody(slug) });
    expect(visible.status).toBe(409);
    expect(invisible.status).toBe(409);
    const strip = (r: typeof visible) => ({ code: r.json.error.code, message: r.json.error.message, details: r.json.error.details });
    expect(strip(visible)).toEqual(strip(invisible));
    expect(visible.json.error.details).toEqual({ reason: "slug_taken" });
  });

  it("rejects a bad timezone, over-length fields and a non-http(s) website with validation_failed", async () => {
    const w = await world();
    const key = w.a.keys.manageSetup.secret;
    const base = fullBody();
    const cases = [
      { ...base, slug: `p-${uniq()}`, timezone: "Mars/Olympus" },
      { ...base, slug: `p-${uniq()}`, name: "x".repeat(81) },
      { ...base, slug: `p-${uniq()}`, tagline: "x".repeat(201) },
      { ...base, slug: `p-${uniq()}`, description: "x".repeat(1001) },
      { ...base, slug: `p-${uniq()}`, websiteUrl: "ftp://example.test" },
    ];
    for (const body of cases) {
      const r = await api("POST", "/projects", { key, body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.code).toBe("validation_failed");
    }
  });

  it("refuses auto_approve + add_to_queue without confirmUnreviewedQueue", async () => {
    const w = await world();
    const body = { ...fullBody(), confirmUnreviewedQueue: false, defaultApprovalPolicy: "auto_approve", defaultSchedulingPolicy: "add_to_queue" };
    const r = await api("POST", "/projects", { key: w.a.keys.manageSetup.secret, body });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("confirmation_required");
  });

  it("replays the stored response for a repeated Idempotency-Key and creates nothing new", async () => {
    const w = await world();
    const key = w.a.keys.manageSetup.secret;
    const body = fullBody();
    const first = await api("POST", "/projects", { key, idem: "proj-1", body });
    expect(first.status).toBe(201);
    const second = await api("POST", "/projects", { key, idem: "proj-1", body });
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(second.json).toEqual(first.json);
  });

  it("answers 409 no_acting_user when the key's creator is gone", async () => {
    const w = await world();
    const created = await createKey(w.a.scope, ["manage_setup"], { rateLimitPerMinute: 1000 });
    await testDb()
      .update(apiKeys)
      .set({ createdByUserId: null })
      .where(and(eq(apiKeys.id, created.id), eq(apiKeys.projectId, w.a.project.id)));
    const r = await api("POST", "/projects", { key: created.secret, body: fullBody() });
    expect(r.status).toBe(409);
    expect(r.json.error.details).toEqual({ reason: "no_acting_user" });
  });
});
