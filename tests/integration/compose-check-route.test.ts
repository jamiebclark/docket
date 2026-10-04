import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as { user: { id: string } } | null }));
vi.mock("@/server/auth/session", () => ({ getSession: async () => session.current }));

import { POST } from "../../src/app/p/[projectSlug]/compose/check/route";
import * as posts from "../../src/server/services/posts";
import { atTime } from "../helpers/clock";
import { closeDb } from "../helpers/db";
import { fakeSession } from "../helpers/auth";
import { createProjectWithMembers } from "../helpers/factories";
import { blueskyLikeProvider, registerTestProvider } from "../helpers/provider-fixtures";
import { postsEnv } from "../helpers/posts-env";
import { forProject } from "../../src/server/dal/scope";
import * as accounts from "../../src/server/services/accounts";
import * as slots from "../../src/server/services/slots";

registerTestProvider(blueskyLikeProvider);

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
    const rule = blueskyLikeProvider.capabilities.text.countingRule;
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
});
