import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("worker bundle", () => {
  it("keeps sharp external (native binaries cannot be bundled)", async () => {
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
    expect(inputs.some((p) => /node_modules\/sharp\//.test(p))).toBe(false);
    const imports = Object.values(result.metafile.outputs).flatMap((o) => o.imports.map((i) => i.path));
    expect(imports).toContain("sharp");
  }, 60_000);

  it("keeps next/* out of the worker and smoke bundles", async () => {
    for (const entry of ["src/worker.ts", "scripts/smoke.ts"]) {
      const result = await build({
        entryPoints: [entry],
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
      expect(inputs.filter((p) => /node_modules\/next\//.test(p)), entry).toEqual([]);
    }
  }, 60_000);
});
