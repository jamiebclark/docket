import { expect, test } from "vitest";
import { imagesForModel } from "../llm/images";
import { setStorageForTests, MEDIA_STORAGE_NOT_SET_UP } from "./index";

test("MEDIA_STORAGE_NOT_SET_UP is the one sentence for 'there is nowhere to put this'", () => {
  expect(MEDIA_STORAGE_NOT_SET_UP).toBe("Media storage is not set up.");
});

test("the image-input path returns the identical, shared sentence when storage is off", async () => {
  setStorageForTests(null);
  try {
    const scope = {} as never;
    const asset = { kind: "image" } as never;
    const r = await imagesForModel(scope, [asset]);
    expect(r).toEqual({ ok: false, message: MEDIA_STORAGE_NOT_SET_UP });
  } finally {
    setStorageForTests(undefined);
  }
});
