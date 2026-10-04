import { describe, expect, it } from "vitest";
import { BodyTooLargeError, readBodyWithin } from "./body";

const post = (init: RequestInit & { duplex?: "half" }) => new Request("http://localhost/x", { method: "POST", ...init });

describe("readBodyWithin", () => {
  it("returns the bytes of a body within the limit, and an empty array for none", async () => {
    expect(new TextDecoder().decode(await readBodyWithin(post({ body: "hello" }), 10))).toBe("hello");
    expect(await readBodyWithin(new Request("http://localhost/x", { method: "POST" }), 10)).toHaveLength(0);
  });

  it("refuses a declared length over the limit before reading", async () => {
    const request = post({ body: "x", headers: { "content-length": "999" } });
    await expect(readBodyWithin(request, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("stops pulling a chunked body with no length once it crosses the limit", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const limit = 200 * 1024;
    await expect(readBodyWithin(post({ body: stream, duplex: "half" }), limit)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancelled).toBe(true);
    // The reader asks for chunks only as it needs them: the limit plus at most a few chunks of read-ahead.
    expect(pulls * 64 * 1024).toBeLessThan(limit + 4 * 64 * 1024);
  });
});
