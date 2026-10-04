import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("worker bundle graph", () => {
  it("does not import the LLM layer or the generation services", async () => {
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
    const offenders = inputs.filter((p) => /src\/server\/(llm|services\/generation)\//.test(p) || /node_modules\/openai\//.test(p));
    expect(offenders).toEqual([]);
  }, 60_000);
});
