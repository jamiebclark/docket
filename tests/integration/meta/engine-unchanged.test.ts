import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { facebookSetup, PAGE_ID } from "../../helpers/facebook-publish";
import { createFakeGraph, type FakeGraph } from "../../helpers/fake-graph";
import { IG_ID, instagramSetup } from "../../helpers/instagram-publish";
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

const T0 = Date.now() + 60_000;
const tickAt = (seconds: number) => atTime(new Date(T0 + seconds * 1000), async () => (await runTick({ config: {} })).publishing.counts);

describe("the unchanged engine publishes both Meta providers", () => {
  it("publishes a Facebook target end to end", async () => {
    graph.on("POST", `/v26.0/${PAGE_ID}/feed`, { kind: "ok", body: { id: `${PAGE_ID}_9` } });
    const { row } = await facebookSetup(storage, "engine check", 0);
    expect(await tickAt(0)).toMatchObject({ claimed: 1, done: 1 });
    expect(await row()).toMatchObject({ status: "published", externalId: `${PAGE_ID}_9` });
  });

  it("publishes an Instagram target end to end", async () => {
    graph.on("POST", `/v26.0/${IG_ID}/media`, { kind: "ok", body: { id: "c1" } });
    graph.on("GET", "/v26.0/c1", { kind: "ok", body: { status_code: "FINISHED" } });
    graph.on("GET", `/v26.0/${IG_ID}/content_publishing_limit`, { kind: "ok", body: { data: [{ quota_usage: 1, config: { quota_total: 100 } }] } });
    graph.on("POST", `/v26.0/${IG_ID}/media_publish`, { kind: "ok", body: { id: "ig_9" } });
    const { row } = await instagramSetup(storage, "engine check", 1);
    await tickAt(0);
    await tickAt(11);
    await tickAt(12);
    await tickAt(13);
    expect(await row()).toMatchObject({ status: "published", externalId: "ig_9" });
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe("provider-neutral layers (FR-002, FR-003)", () => {
  it("name no Meta provider by string literal in the scheduler, services, schema or posts UI", () => {
    const roots = [
      "src/server/scheduler",
      "src/server/services",
      "src/server/db/schema",
      "src/app/p/[projectSlug]/posts",
      "src/app/p/[projectSlug]/accounts",
      "src/app/connect",
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      let files: string[] = [];
      try {
        files = sourceFiles(root);
      } catch {
        continue; // a root that does not exist has nothing to violate
      }
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        if (/["'`](facebook|instagram|meta)["'`]/i.test(text) || /\b(pages|instagram)_[a-z_]+\b/.test(text)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
