// Spec US1: one video on a Facebook target publishes as a Page video with one POST /{page}/videos, by default.
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb, testDb } from "../../helpers/db";
import { facebookVideoSetup, PAGE_ID } from "../../helpers/facebook-publish";
import { createFakeGraph, type FakeGraph } from "../../helpers/fake-graph";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";

let graph: FakeGraph;
let storage: MemoryStorage;
beforeEach(async () => {
  await parkAllDueTargets();
  graph = createFakeGraph().install();
  storage = createMemoryStorage();
  setStorageForTests(storage);
});
afterEach(() => graph.uninstall());
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

const videos = `/v26.0/${PAGE_ID}/videos`;

describe("Facebook Page video through the real scheduler", () => {
  it("publishes with the default type in one request and no Reels request", async () => {
    graph.on("POST", videos, { kind: "ok", body: { id: "vid_1" } });
    const { tick, row } = await facebookVideoSetup(storage, "A video");
    expect(await tick()).toMatchObject({ claimed: 1, done: 1 });

    const requests = graph.requests.filter((r) => r.method === "POST");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe(videos);
    expect(requests[0]!.params.file_url).toMatch(/^http/);
    expect(requests[0]!.params.description).toBe("A video");
    expect(graph.requests.some((r) => r.path.includes("video_reels"))).toBe(false);
    expect(await row()).toMatchObject({ status: "published", externalId: "vid_1" });
  });

  it("publishes with an explicit video choice the same way", async () => {
    graph.on("POST", videos, { kind: "ok", body: { id: "vid_2" } });
    const { tick, row } = await facebookVideoSetup(storage, "A video", { postType: "video" });
    expect(await tick()).toMatchObject({ done: 1 });
    expect(await row()).toMatchObject({ status: "published", externalId: "vid_2" });
  });

  it("code 389 fails the target with the public-storage guidance", async () => {
    graph.on("POST", videos, { kind: "graph_error", code: 389, message: "Unable to fetch video file from URL.", status: 400 });
    const { tick, row } = await facebookVideoSetup(storage, "A video");
    expect(await tick()).toMatchObject({ failed: 1 });
    const r = await row();
    expect(r.status).toBe("failed");
    expect(r.lastError).toContain("publicly readable");
  });

  it("code 190 fails the target and flags the account", async () => {
    graph.on("POST", videos, { kind: "graph_error", code: 190, message: "Invalid OAuth access token", status: 401 });
    const { tick, row, accountId, projectId } = await facebookVideoSetup(storage, "A video");
    expect(await tick()).toMatchObject({ failed: 1 });
    expect((await row()).status).toBe("failed");
    const [account] = await testDb().select().from(socialAccounts).where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, accountId)));
    expect(account!.status).toBe("needs_reauth");
  });

  it("a dropped reply after send is ambiguous and is not sent again", async () => {
    graph.on("POST", videos, { kind: "reset_mid_body" });
    const { tick, row } = await facebookVideoSetup(storage, "A video");
    expect(await tick()).toMatchObject({ ambiguous: 1 });
    expect((await row()).status).toBe("ambiguous");
    const sent = graph.requests.length;
    expect(await tick()).toMatchObject({ claimed: 0 });
    expect(graph.requests).toHaveLength(sent);
  });
});
