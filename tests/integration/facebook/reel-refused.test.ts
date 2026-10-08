// Spec US5 (G15): a video that does not fit a Reel is refused by the engine's re-check, with no Graph or rupload request.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { facebookVideoSetup } from "../../helpers/facebook-publish";
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

describe("a Reel that breaks a Reel limit is refused at publish time", () => {
  it("fails with the Reel wording and makes no Graph or rupload request", async () => {
    const { row } = await facebookVideoSetup(storage, "landscape reel", { postType: "reel", video: { width: 1920, height: 1080 } });
    await atTime(new Date(Date.now() + 60_000), () => runTick({ config: {} }));
    const after = await row();
    expect(after.status).toBe("failed");
    expect(after.lastError).toContain("Facebook Reels must be 9:16 (vertical)");
    expect(graph.requests).toEqual([]);
  });
});
