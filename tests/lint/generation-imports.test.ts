import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("worker bundle graph", () => {
  it("includes the job runner and the LLM layer, and imports nothing from next/*", async () => {
    const result = await build({
      entryPoints: ["src/worker.ts"],
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
      external: ["pg-native", "sharp"],
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some((p) => p.endsWith("src/server/services/jobs/runner.ts"))).toBe(true);
    expect(inputs.some((p) => /src\/server\/llm\//.test(p))).toBe(true);
    const nextImports = inputs.filter((p) => /node_modules\/next\//.test(p));
    expect(nextImports).toEqual([]);
    const importsNext = Object.values(result.metafile.inputs).flatMap((i) => i.imports.map((x) => x.path)).filter((p) => p === "next" || p.startsWith("next/"));
    expect(importsNext).toEqual([]);
  }, 60_000);
});
