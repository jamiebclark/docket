import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const request = { headers: new Headers() };

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));

import { ensureProblemsViewMarked } from "../../../src/components/notifications/request";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import { unreadSummary } from "../../../src/server/services/notifications";
import { actAs } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { recordEvent, startReading } from "../../helpers/notifications";

afterAll(async () => {
  actAs(null);
  await closeDb();
});
beforeEach(() => {
  request.headers = new Headers();
});

async function setup() {
  const u = await createUser();
  const a = await createProject({ name: "Alpha" });
  const b = await createProject({ name: "Bravo" });
  await addMember(a.id, u.id, "editor");
  await addMember(b.id, u.id, "editor");
  await startReading(a.id, u.id);
  await startReading(b.id, u.id);
  await recordEvent(a.id, "target_failed");
  await recordEvent(b.id, "target_failed");
  actAs(u);
  const count = async () => (await unreadSummary(await forMyProjects({ user: { id: u.id } }))).count;
  return { a, b, count };
}

async function visit(path: string, extra: Record<string, string> = {}) {
  request.headers = new Headers({ "x-docket-path": path, ...extra });
  await ensureProblemsViewMarked();
}

describe("viewing the problems marks them read", () => {
  it("project problems view marks only that project", async () => {
    const { a, count } = await setup();
    expect(await count()).toBe(2);
    await visit(`/p/${a.slug}/activity?outcome=problems`);
    expect(await count()).toBe(1);
  });

  it("the all-projects view marks every shown project, or only the named one", async () => {
    const { a, count } = await setup();
    await visit(`/activity?outcome=problems&project=${a.slug}`);
    expect(await count()).toBe(1);
    await visit("/activity?outcome=problems");
    expect(await count()).toBe(0);
  });

  it("any narrower or other view marks nothing", async () => {
    const { a, count } = await setup();
    for (const path of [
      `/p/${a.slug}/activity`,
      `/p/${a.slug}/activity?outcome=successes`,
      `/p/${a.slug}/activity?outcome=problems&platform=bluesky`,
      `/p/${a.slug}/activity?outcome=problems&before=abc`,
      "/activity?outcome=problems&range=7d",
      "/activity",
    ]) {
      await visit(path);
      expect(await count()).toBe(2);
    }
  });

  it("prefetches mark nothing", async () => {
    const { a, count } = await setup();
    await visit(`/p/${a.slug}/activity?outcome=problems`, { "next-router-prefetch": "1" });
    await visit("/activity?outcome=problems", { "sec-purpose": "prefetch" });
    expect(await count()).toBe(2);
  });

  it("the header count in the same request is already updated, and later problems count", async () => {
    const { a, count } = await setup();
    await visit(`/p/${a.slug}/activity?outcome=problems`);
    expect(await count()).toBe(1);
    await recordEvent(a.id, "target_failed");
    expect(await count()).toBe(2);
  });
});
