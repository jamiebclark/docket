import { expect, test } from "vitest";

test("image-generation is an interface only: no runtime exports", async () => {
  const mod = await import("./image-generation");
  expect(Object.keys(mod)).toEqual([]);
});
