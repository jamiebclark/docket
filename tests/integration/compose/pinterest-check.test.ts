import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccountDetailsCache } from "../../../src/server/services/account-details";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";
import { getCalendar } from "../../../src/server/services/calendar";
import { getPostView } from "../../../src/server/services/posts/view";
import { listPosts } from "../../../src/server/services/posts/list";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { closeDb } from "../../helpers/db";
import { boardsPage, createFakePinterest } from "../../helpers/fake-pinterest";
import { postsEnv } from "../../helpers/posts-env";

const BOARDS = "/v5/boards";
const fake = createFakePinterest();

beforeEach(() => {
  vi.stubEnv("PINTEREST_CLIENT_ID", "CLIENT-ID");
  vi.stubEnv("PINTEREST_CLIENT_SECRET", "CLIENT-SECRET-XYZ");
  clearAccountDetailsCache();
  fake.reset();
  fake.install();
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});
afterAll(closeDb);

async function setup() {
  const env = await postsEnv();
  const account = await accounts.saveConnectedAccount(env.scope, {
    providerKey: "pinterest",
    externalAccountId: "pinterest-user-1",
    displayName: "Ada's Studio",
    settings: {},
    credentials: {
      v: 1,
      accessToken: "PIN-ACCESS-0123456789",
      refreshToken: "PIN-REFRESH-0123456789",
      accessExpiresAt: Date.now() + 20 * 86_400_000,
      refreshIssuedAt: Date.now(),
      refreshExpiresAt: Date.now() + 60 * 86_400_000,
      refreshExpiryEstimated: false,
    },
  });
  return { env, account };
}

async function media(projectId: string) {
  const row = await forSchedulerProject(projectId).media.insert({
    storageKey: `test/${Math.random().toString(36).slice(2)}.jpg`,
    publicUrl: "https://media.example.test/pin.jpg",
    mimeType: "image/jpeg",
    byteSize: 1_000_000,
    width: 400,
    height: 600,
  });
  return row.id;
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function check(s: Setup, mediaId: string, target: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const result = await posts.checkComposition(s.env.scope, {
    baseText: "hello",
    mediaIds: [mediaId],
    targets: [{ accountId: s.account.id, ...target }],
    ...extra,
  });
  return result.targets[0]!;
}

const errors = (t: Awaited<ReturnType<typeof check>>) => t.issues.filter((i) => i.severity === "error").map((i) => `${i.code}@${i.field}`);

describe("composer check: Pinterest posting panel", () => {
  it("refuses with no board chosen", async () => {
    const s = await setup();
    fake.on("GET", BOARDS, { kind: "ok", body: boardsPage([{ id: "b1", name: "Recipes" }]) });
    const mediaId = await media(s.env.project.id);
    const t = await check(s, mediaId, { posting: {} });
    expect(errors(t)).toContain("board_required@posting.boardId");
    expect(t.canSchedule).toBe(false);
  });

  it("lists every board in Pinterest's order with nothing pre-selected", async () => {
    const s = await setup();
    fake.on("GET", BOARDS, { kind: "ok", body: boardsPage([{ id: "b1", name: "Recipes" }, { id: "b2", name: "Travel" }]) });
    const mediaId = await media(s.env.project.id);
    const t = await check(s, mediaId);
    const field = t.posting!.fields.find((f) => f.key === "boardId")!;
    if (field.kind !== "choice") throw new Error("choice");
    expect(field.value).toBeNull();
    expect(field.options.map((o) => o.label)).toEqual(["Recipes", "Travel"]);
  });

  it("follows two pages for a 300-board account", async () => {
    const s = await setup();
    const page1 = Array.from({ length: 250 }, (_, i) => ({ id: `b${i}`, name: `Board ${i}` }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({ id: `b${250 + i}`, name: `Board ${250 + i}` }));
    fake.on("GET", BOARDS, [{ kind: "ok", body: boardsPage(page1, "bm1") }, { kind: "ok", body: boardsPage(page2) }]);
    const mediaId = await media(s.env.project.id);
    const t = await check(s, mediaId);
    const field = t.posting!.fields.find((f) => f.key === "boardId")!;
    if (field.kind !== "choice") throw new Error("choice");
    expect(field.options).toHaveLength(300);
  });

  it("shows the no-boards state and refuses with no_boards", async () => {
    const s = await setup();
    fake.on("GET", BOARDS, { kind: "ok", body: boardsPage([]) });
    const mediaId = await media(s.env.project.id);
    const t = await check(s, mediaId, { posting: {} });
    const field = t.posting!.fields.find((f) => f.key === "boardId")!;
    if (field.kind !== "choice") throw new Error("choice");
    expect(field.options).toEqual([]);
    expect(field.disabled?.reason).toBe("This Pinterest account has no public boards. Create one on Pinterest, then choose it here.");
    expect(errors(t)).toContain("no_boards@posting.boardId");
    expect(t.canSchedule).toBe(false);
  });

  it("reports a failed board read with Retry, keeping the stored board intact", async () => {
    const s = await setup();
    fake.on("GET", BOARDS, { kind: "http", status: 503 });
    const mediaId = await media(s.env.project.id);
    const t = await check(s, mediaId, { posting: { boardId: "stored-1", boardName: "Stored board" } });
    expect(t.posting!.details).toBe("error");
    expect(t.posting!.detailsError).toBeTruthy();
    const field = t.posting!.fields.find((f) => f.key === "boardId")!;
    if (field.kind !== "choice") throw new Error("choice");
    expect(field.value).toBe("stored-1");
    expect(field.disabled).toBeTruthy();
    expect(t.canSchedule).toBe(false);
  });

  it("Retry sends refreshDetails and is not served from the cache", async () => {
    const s = await setup();
    fake.on("GET", BOARDS, { kind: "ok", body: boardsPage([{ id: "b1", name: "Recipes" }]) });
    const mediaId = await media(s.env.project.id);
    await check(s, mediaId);
    await check(s, mediaId);
    expect(fake.callsTo("GET", BOARDS)).toHaveLength(1);
    await check(s, mediaId, {}, { refreshDetails: true });
    expect(fake.callsTo("GET", BOARDS)).toHaveLength(2);
  });

  it("keeps a stored board that is no longer on Pinterest, disabled and labelled, with board_not_found", async () => {
    const s = await setup();
    fake.on("GET", BOARDS, { kind: "ok", body: boardsPage([{ id: "b1", name: "Recipes" }]) });
    const mediaId = await media(s.env.project.id);
    const t = await check(s, mediaId, { posting: { boardId: "gone", boardName: "Old board" } });
    const field = t.posting!.fields.find((f) => f.key === "boardId")!;
    if (field.kind !== "choice") throw new Error("choice");
    const stale = field.options.find((o) => o.value === "gone")!;
    expect(stale.label).toMatch(/Old board.*no longer on Pinterest/);
    expect(stale.disabled).toBeTruthy();
    expect(errors(t)).toContain("board_not_found@posting.boardId");
  });

  it("keeps two Pinterest accounts on one post each with their own board", async () => {
    const s = await setup();
    const other = await accounts.saveConnectedAccount(s.env.scope, {
      providerKey: "pinterest",
      externalAccountId: "pinterest-user-2",
      displayName: "Second Studio",
      settings: {},
      credentials: {
        v: 1,
        accessToken: "PIN-ACCESS-2-0123456789",
        refreshToken: "PIN-REFRESH-2-0123456789",
        accessExpiresAt: Date.now() + 20 * 86_400_000,
        refreshIssuedAt: Date.now(),
        refreshExpiresAt: Date.now() + 60 * 86_400_000,
        refreshExpiryEstimated: false,
      },
    });
    fake.on("GET", BOARDS, { kind: "ok", body: boardsPage([{ id: "b1", name: "Recipes" }, { id: "b2", name: "Travel" }]) });
    const mediaId = await media(s.env.project.id);
    const result = await posts.checkComposition(s.env.scope, {
      baseText: "hello",
      mediaIds: [mediaId],
      targets: [
        { accountId: s.account.id, posting: { boardId: "b1", boardName: "Recipes" } },
        { accountId: other.id, posting: { boardId: "b2", boardName: "Travel" } },
      ],
    });
    expect(result.targets[0]!.note).toBe("Board: Recipes");
    expect(result.targets[1]!.note).toBe("Board: Travel");
  });

  it("renders the board note in the composer card, posts list, post detail page and calendar", async () => {
    const s = await setup();
    fake.on("GET", BOARDS, { kind: "ok", body: boardsPage([{ id: "b1", name: "Recipes" }]) });
    const mediaId = await media(s.env.project.id);
    const checked = await check(s, mediaId, { posting: { boardId: "b1", boardName: "Recipes" } });
    expect(checked.note).toBe("Board: Recipes");

    const repos = forSchedulerProject(s.env.project.id);
    const post = await repos.posts.insert({ baseText: "hello" });
    await repos.posts.setMedia(post.id, [mediaId]);
    const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: s.account.id }]);
    const due = new Date(Date.now() - 60_000);
    await repos.targets.update(target!.id, {
      status: "scheduled",
      scheduleKind: "explicit",
      scheduledAt: due,
      nextAttemptAt: due,
      postingFields: { v: 1, boardId: "b1", boardName: "Recipes", title: "", link: "" },
    });
    await repos.posts.setStatus(post.id, "scheduled");

    const list = await listPosts(s.env.scope);
    const item = list.items.find((i) => i.id === post.id)!;
    expect(item.targets[0]!.note).toBe("Board: Recipes");

    const view = await getPostView(s.env.scope, post.id);
    expect(view.targets[0]!.note).toBe("Board: Recipes");

    const calendar = await getCalendar(s.env.scope, { view: "month", date: due.toISOString().slice(0, 10) });
    const days = calendar.days.flatMap((d) => d.items);
    const calItem = days.find((i) => i.kind === "target" && i.targetId === target!.id);
    expect(calItem && "note" in calItem ? calItem.note : null).toBe("Board: Recipes");
  });

  it("shows the Trial line in the notice, summary notes and account card, never calling a published pin public", async () => {
    const s = await setup();
    fake.on("GET", BOARDS, { kind: "ok", body: boardsPage([{ id: "b1", name: "Recipes" }]) });
    const mediaId = await media(s.env.project.id);
    const t = await check(s, mediaId);
    expect(t.posting!.notice?.text).toMatch(/Trial access/);
    expect(t.posting!.notice?.text).not.toMatch(/\bpublic\b/i);
    expect(t.requirements?.notes?.some((n) => /Trial access/.test(n))).toBe(true);
    for (const n of t.requirements?.notes ?? []) expect(n).not.toMatch(/\bpublic\b/i);
    const view = await accounts.listAccounts(s.env.scope);
    const card = view.find((a) => a.id === s.account.id)!;
    expect(card.notes?.some((n) => /Trial access/.test(n))).toBe(true);
    for (const n of card.notes ?? []) expect(n).not.toMatch(/\bpublic\b/i);
  });
});
