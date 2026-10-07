// Worker-only guard (research P21): the web process never sets the mark, so a stray import cannot spawn ffmpeg.
const MARK = Symbol.for("docket.worker-process");

type Marked = typeof globalThis & { [MARK]?: boolean };

/** Called first in `src/worker.ts`. */
export function markWorkerProcess(): void {
  (globalThis as Marked)[MARK] = true;
}

export function assertWorkerProcess(): void {
  if (!(globalThis as Marked)[MARK]) throw new Error("Video tools run only in the worker process.");
}

/** Test seam. */
export function unmarkWorkerProcessForTests(): void {
  delete (globalThis as Marked)[MARK];
}
