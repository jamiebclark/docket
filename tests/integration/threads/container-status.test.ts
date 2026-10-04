import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createFakeGraph, type FakeGraph } from "../../helpers/fake-graph";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";
import { scriptThreads, THREADS_USER_ID, threadsSetup, V } from "../../helpers/threads-publish";

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

const T0 = Date.now() + 60_000;
/** Ticks with the engine clock pinned `seconds` after T0 (no sleeping). */
const tickAt = (seconds: number) => atTime(new Date(T0 + seconds * 1000), async () => (await runTick({ config: {} })).publishing.counts);
const U = THREADS_USER_ID;

const publishRequests = () => graph.requests.filter((r) => r.path.endsWith("/threads_publish"));
const creates = () => graph.requests.filter((r) => r.method === "POST" && r.path.endsWith(`/${U}/threads`));

describe("Threads container status handling", () => {
  it("IN_PROGRESS keeps returning continue with a not-before", async () => {
    scriptThreads(graph).create(["1001"]).status("1001", ["IN_PROGRESS"]);
    const { row } = await threadsSetup(storage, { text: "slow" });
    await tickAt(0);
    for (const s of [31, 92, 153]) {
      expect(await tickAt(s)).toMatchObject({ claimed: 1, continued: 1 });
      expect((await row()).nextAttemptAt!.getTime() - (T0 + s * 1000)).toBe(60_000);
    }
    expect(publishRequests()).toHaveLength(0);
  });

  it("gives up after 5 minutes of IN_PROGRESS without publishing", async () => {
    scriptThreads(graph).create(["1001"]).status("1001", ["IN_PROGRESS"]);
    const { row } = await threadsSetup(storage, { text: "stuck" });
    await tickAt(0);
    expect(await tickAt(31)).toMatchObject({ claimed: 1, continued: 1 });
    expect(await tickAt(301)).toMatchObject({ claimed: 1, failed: 1 });
    expect(publishRequests()).toHaveLength(0);
    const final = await row();
    expect(final.status).toBe("failed");
    expect(final.lastError).toContain("Threads did not finish processing the post");
  });

  it.each([
    ["with a reason", { status: "ERROR", error_message: "Invalid image format" }, "Invalid image format"],
    ["without a reason", "ERROR", "status ERROR"],
  ])("ERROR %s fails and never publishes", async (_label, status, expected) => {
    scriptThreads(graph).create(["1001"]).status("1001", [status]);
    const { row } = await threadsSetup(storage, { text: "bad" });
    await tickAt(0);
    expect(await tickAt(31)).toMatchObject({ claimed: 1, failed: 1 });
    expect(publishRequests()).toHaveLength(0);
    const final = await row();
    expect(final.status).toBe("failed");
    expect(final.lastError).toContain(expected);
  });

  it("EXPIRED recreates from the first step and succeeds on retry", async () => {
    let n = 0;
    graph.on("POST", `${V}/${U}/threads`, () => ({ kind: "ok", body: { id: String(1000 + ++n) } }));
    scriptThreads(graph).status("1001", ["EXPIRED"]).status("1002", ["FINISHED"]).quota(1).publish("th_re");
    const { row } = await threadsSetup(storage, { text: "again" });
    await tickAt(0); // create 1001
    expect(await tickAt(31)).toMatchObject({ claimed: 1, continued: 1 }); // EXPIRED → recreate
    expect(await tickAt(32)).toMatchObject({ claimed: 1, continued: 1 }); // create 1002
    expect(await tickAt(63)).toMatchObject({ claimed: 1, continued: 1 }); // FINISHED
    await tickAt(64);
    expect(await tickAt(65)).toMatchObject({ claimed: 1, done: 1 });
    expect(creates()).toHaveLength(2);
    expect(publishRequests()).toHaveLength(1);
    expect(await row()).toMatchObject({ status: "published", externalId: "th_re" });
  });

  it("a third EXPIRED fails with the cap message", async () => {
    let n = 0;
    graph.on("POST", `${V}/${U}/threads`, () => ({ kind: "ok", body: { id: String(1000 + ++n) } }));
    for (const id of ["1001", "1002", "1003"]) scriptThreads(graph).status(id, ["EXPIRED"]);
    const { row } = await threadsSetup(storage, { text: "never" });
    let s = 0;
    for (let round = 0; round < 2; round++) {
      await tickAt(s); // create
      s += 31;
      expect(await tickAt(s)).toMatchObject({ claimed: 1, continued: 1 }); // EXPIRED → recreate
      s += 1;
    }
    await tickAt(s); // third create
    s += 31;
    expect(await tickAt(s)).toMatchObject({ claimed: 1, failed: 1 });
    expect(creates()).toHaveLength(3);
    expect(publishRequests()).toHaveLength(0);
    const final = await row();
    expect(final.status).toBe("failed");
    expect(final.lastError).toContain("tried 3 times");
  });

  it("PUBLISHED before our publish is ambiguous and nothing is published", async () => {
    scriptThreads(graph).create(["1001"]).status("1001", ["PUBLISHED"]);
    await threadsSetup(storage, { text: "dup" });
    await tickAt(0);
    expect(await tickAt(31)).toMatchObject({ claimed: 1, ambiguous: 1 });
    expect(publishRequests()).toHaveLength(0);
  });

  it("an unknown status is retried", async () => {
    scriptThreads(graph).create(["1001"]).status("1001", ["WEIRD", "FINISHED"]);
    const { row } = await threadsSetup(storage, { text: "odd" });
    await tickAt(0);
    expect(await tickAt(31)).toMatchObject({ claimed: 1, retried: 1 });
    expect(publishRequests()).toHaveLength(0);
    expect((await row()).status).not.toBe("failed");
  });
});
