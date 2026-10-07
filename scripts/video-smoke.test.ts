import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("scripts/video-smoke.ts", () => {
  it("marks itself as the worker process before running the pipeline", () => {
    const src = readFileSync(join(__dirname, "video-smoke.ts"), "utf8");
    const main = src.slice(src.indexOf("async function main()"));
    expect(main.indexOf("markWorkerProcess()")).toBeGreaterThan(-1);
    expect(main.indexOf("markWorkerProcess()")).toBeLessThan(main.indexOf("createVideoFixtures()"));
  });
});
