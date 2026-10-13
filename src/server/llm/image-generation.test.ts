import { expect, test } from "vitest";

test("image-generation exports exactly the contract's vocabulary, and no vendor value", async () => {
  const mod = await import("./image-generation");
  expect(Object.keys(mod).sort()).toEqual(
    ["DEFAULT_IMAGE_ASPECT", "IMAGE_ASPECTS", "IMAGE_PROMPT_MAX", "NO_REAL_PEOPLE"].sort(),
  );
  expect(mod.IMAGE_ASPECTS).toEqual(["square", "portrait", "landscape"]);
  expect(mod.DEFAULT_IMAGE_ASPECT).toBe("square");
  expect(mod.IMAGE_PROMPT_MAX).toBe(1000);
  expect(mod.NO_REAL_PEOPLE.length).toBeGreaterThan(0);

  const text = JSON.stringify(mod);
  // No pixel size, provider name or model id anywhere in the vocabulary.
  expect(text).not.toMatch(/\d{3,4}x\d{3,4}/);
  expect(text).not.toMatch(/openai|anthropic/i);
});
