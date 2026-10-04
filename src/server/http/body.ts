export class BodyTooLargeError extends Error {
  constructor() {
    super("The request body is too large.");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Reads a request body into bytes, refusing as soon as it crosses `limit` (FR-025). A declared `Content-Length`
 * over the limit is refused before anything is read; a body without one is streamed and cancelled at the limit.
 */
export async function readBodyWithin(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError();
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
