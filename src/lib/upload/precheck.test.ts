import { describe, expect, it } from "vitest";
import { precheck } from "./precheck";
import { MIB, mp4File, pngFile, TEST_LIMITS, textFile } from "./test-support";

const head = async (f: File) => new Uint8Array(await f.slice(0, 64).arrayBuffer());
const run = async (f: File, video: Parameters<typeof precheck>[2] = async () => ({ durationSeconds: 10, width: 1280, height: 720 })) =>
  precheck({ size: f.size, head: await head(f) }, TEST_LIMITS, video);

describe("precheck", () => {
  it("passes an image and a readable video", async () => {
    expect(await run(pngFile())).toMatchObject({ ok: true, kind: "image", mimeType: "image/png", checksAfterUpload: false });
    expect(await run(mp4File())).toMatchObject({ ok: true, kind: "video", mimeType: "video/mp4", checksAfterUpload: false });
  });

  it("refuses by contents, whatever the name says", async () => {
    expect(await run(textFile("pic.png"))).toMatchObject({ ok: false, code: "unsupported_type" });
    expect(await run(new File([], "empty.png"))).toMatchObject({ ok: false, code: "unsupported_type" });
  });

  it("refuses an oversize file before reading the video", async () => {
    let read = false;
    const big = { size: TEST_LIMITS.video.maxBytes + 1, head: await head(mp4File()) };
    const res = await precheck(big, TEST_LIMITS, async () => ((read = true), null));
    expect(res).toMatchObject({ ok: false, code: "too_large", values: { size: big.size } });
    expect(read).toBe(false);
    const img = { size: TEST_LIMITS.image.maxBytes + 1, head: await head(pngFile()) };
    expect(await precheck(img, TEST_LIMITS, async () => null)).toMatchObject({ ok: false, code: "too_large" });
  });

  it("refuses a video that is too long, too big or has no picture", async () => {
    const f = mp4File("a.mp4", 2 * MIB);
    expect(await run(f, async () => ({ durationSeconds: TEST_LIMITS.video.maxSeconds + 1, width: 100, height: 100 }))).toMatchObject({
      ok: false,
      code: "too_long",
    });
    expect(await run(f, async () => ({ durationSeconds: 5, width: 100, height: TEST_LIMITS.video.maxSide + 1 }))).toMatchObject({
      ok: false,
      code: "too_big",
      values: { side: TEST_LIMITS.video.maxSide + 1 },
    });
    expect(await run(f, async () => ({ durationSeconds: 5, width: 0, height: 0 }))).toMatchObject({ ok: false, code: "no_video" });
  });

  it("passes a video the browser cannot read, to be checked after upload", async () => {
    expect(await run(mp4File(), async () => null)).toMatchObject({ ok: true, kind: "video", checksAfterUpload: true });
  });
});
