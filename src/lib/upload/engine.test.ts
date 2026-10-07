import { describe, expect, it, vi } from "vitest";
import {
  createUploadEngine,
  MAX_CONCURRENT,
  type AssetLike,
  type EngineEvent,
  type StatusItem,
  type Transport,
  type UploadActions,
} from "./engine";
import { MIB, mp4File, pngFile, TEST_LIMITS, textFile } from "./test-support";

const PART = 8 * MIB;

function manualClock() {
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let id = 0;
  return {
    setTimeout(fn: () => void, ms: number) {
      timers.push({ fn, ms, id: ++id });
      return id;
    },
    clearTimeout(h: unknown) {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    pending: () => timers.length,
    runAll() {
      for (const t of timers.splice(0)) t.fn();
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Runs microtasks and due timers until nothing more happens (but never the 2 s status poll). */
async function settle(clock: ReturnType<typeof manualClock>, opts: { timers?: boolean } = { timers: true }) {
  for (let i = 0; i < 40; i++) {
    await flush();
    if (opts.timers && clock.pending() > 0) clock.runAll();
  }
}

interface Fake {
  engine: ReturnType<typeof makeEngine>["engine"];
}

function makeEngine(opts: {
  send?: (url: string, n: number, blob: Blob, call: number) => Promise<{ status: number; message?: string }> | { status: number; message?: string };
  videoMeta?: (f: File) => Promise<{ durationSeconds: number; width: number; height: number } | null>;
  statusItems?: () => StatusItem<AssetLike>[];
  completeStatus?: AssetLike["status"];
  /** The first completeUpload succeeds on the server but its answer is lost. */
  loseFirstCompleteAnswer?: boolean;
} = {}) {
  const clock = manualClock();
  const sessions = new Map<string, { partSize: number; count: number; total: number; stored: Map<number, number> }>();
  const calls = { create: 0, sign: [] as number[][], list: 0, complete: 0, cancel: [] as string[], status: 0, sent: [] as number[] };
  let next = 0;
  let finished = false;
  const events: EngineEvent<AssetLike>[] = [];
  const ok = <T,>(data: T) => ({ ok: true as const, data });
  const actions: UploadActions<AssetLike> = {
    async createUpload(input) {
      calls.create++;
      const id = `u${++next}`;
      const count = Math.ceil(input.bytes / PART);
      sessions.set(id, { partSize: PART, count, total: input.bytes, stored: new Map() });
      return ok({ ok: true as const, upload: { id, partSize: PART, partCount: count, transport: "direct" as const } });
    },
    async signUploadParts({ uploadId, partNumbers }) {
      calls.sign.push(partNumbers);
      return ok({ ok: true as const, parts: partNumbers.map((n) => ({ partNumber: n, url: `fake://${uploadId}/${n}`, expiresAt: "" })) });
    },
    async listUploadedParts({ uploadId }) {
      calls.list++;
      if (finished) return ok({ ok: false as const, code: "upload_finished" as const, message: "This upload has already finished." });
      const s = sessions.get(uploadId)!;
      const parts = [...s.stored].map(([partNumber, bytes]) => ({ partNumber, bytes }));
      return ok({ ok: true as const, parts, confirmedBytes: parts.reduce((a, p) => a + p.bytes, 0) });
    },
    async completeUpload({ uploadId }) {
      calls.complete++;
      if (opts.loseFirstCompleteAnswer && calls.complete === 1) {
        finished = true;
        throw new Error("network");
      }
      return ok({
        ok: true as const,
        asset: {
          id: `asset-${uploadId}`,
          status: opts.completeStatus ?? "processing",
          processingStep: "queued" as const,
          processingError: null,
        },
      });
    },
    async cancelUpload({ uploadId }) {
      calls.cancel.push(uploadId);
      return ok({ ok: true as const });
    },
    async status() {
      calls.status++;
      return ok({ ok: true as const, items: opts.statusItems?.() ?? [] });
    },
  };
  let sendCount = 0;
  const transport: Transport = {
    async sendPart(url, blob, { onProgress }) {
      const [, uploadId, n] = /fake:\/\/(\w+)\/(\d+)/.exec(url)!;
      const call = ++sendCount;
      onProgress(Math.floor(blob.size / 2));
      const res = await (opts.send?.(url, Number(n), blob, call) ?? { status: 200 });
      if (res.status === 200) {
        onProgress(blob.size);
        sessions.get(uploadId!)!.stored.set(Number(n), blob.size);
        calls.sent.push(Number(n));
      }
      return res;
    },
  };
  const engine = createUploadEngine<AssetLike>({
    actions,
    transport,
    readVideo: async (f) => (opts.videoMeta ? opts.videoMeta(f) : { durationSeconds: 10, width: 1280, height: 720 }),
    readHead: async (f) => new Uint8Array(await f.slice(0, 64).arrayBuffer()),
    limits: TEST_LIMITS,
    clock,
    onEvent: (e) => events.push(e),
  });
  return { engine, clock, calls, events, sessions };
}

const hugeJpeg = () => {
  const bytes = new Uint8Array(TEST_LIMITS.image.maxBytes + 1);
  bytes.set([0xff, 0xd8, 0xff]);
  return new File([bytes], "huge.jpg");
};
const states = (e: Fake["engine"]) => e.snapshot().map((r) => r.state);

describe("upload engine", () => {
  it("reports progress, announces each milestone once and finishes processing", async () => {
    const { engine, clock, events } = makeEngine();
    engine.add([mp4File()]);
    await settle(clock, { timers: false });
    expect(engine.snapshot()[0]).toMatchObject({ state: "processing", bytesSent: 33 * MIB, step: "queued", assetId: "asset-u1" });
    const types = events.map((e) => (e.type === "milestone" ? `m${e.pct}` : e.type));
    expect(types).toEqual(["started", "m25", "m50", "m75", "uploaded"]);
  });

  it("refuses before any action call: wrong contents, too large, too long", async () => {
    const { engine, clock, calls } = makeEngine({ videoMeta: async () => ({ durationSeconds: TEST_LIMITS.video.maxSeconds + 1, width: 10, height: 10 }) });
    engine.add([textFile("renamed.png"), mp4File("long.mp4", 2 * MIB), hugeJpeg()]);
    await settle(clock);
    expect(states(engine)).toEqual(["refused", "refused", "refused"]);
    expect(engine.snapshot().map((r) => r.reason)).toMatchObject([
      { kind: "precheck", code: "unsupported_type" },
      { kind: "precheck", code: "too_long" },
      { kind: "precheck", code: "too_large" },
    ]);
    expect(calls.create + calls.sign.length + calls.complete).toBe(0);
    expect(calls.sent).toEqual([]);
  });

  it("passes an unreadable video and says the checks happen after upload", async () => {
    const { engine, clock } = makeEngine({ videoMeta: async () => null });
    engine.add([mp4File("odd.mp4", 2 * MIB)]);
    await settle(clock, { timers: false });
    expect(engine.snapshot()[0]).toMatchObject({ checksAfterUpload: true, state: "processing" });
  });

  it("keeps at most three files uploading, and one failure does not stop the other five (SC-004)", async () => {
    let running = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const { engine, clock } = makeEngine({
      async send(_u, _n, _b, call) {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>((r) => gates.push(r));
        running--;
        return { status: call === 2 ? 500 : 200 };
      },
    });
    engine.add(Array.from({ length: 6 }, (_, i) => pngFile(`p${i}.png`)));
    await flush();
    await flush();
    await flush();
    expect(states(engine).filter((s) => s === "uploading")).toHaveLength(MAX_CONCURRENT);
    expect(states(engine).filter((s) => s === "waiting")).toHaveLength(3);
    for (let i = 0; i < 20; i++) {
      gates.splice(0).forEach((g) => g());
      await settle(clock, { timers: false });
    }
    expect(peak).toBe(MAX_CONCURRENT);
    expect(states(engine).filter((s) => s === "interrupted")).toHaveLength(1);
    expect(states(engine).filter((s) => s === "processing")).toHaveLength(5);
    expect(engine.snapshot().find((r) => r.state === "interrupted")?.reason).toEqual({ kind: "storage" });
  });

  it("retries a dropped connection twice on its own, then interrupts; Retry resumes at the confirmed parts (SC-003)", async () => {
    let failing = true;
    const { engine, clock, calls } = makeEngine({ send: (_u, n) => (failing && n === 3 ? { status: 0 } : { status: 200 }) });
    engine.add([mp4File()]);
    await settle(clock);
    const row = engine.snapshot()[0]!;
    expect(row).toMatchObject({ state: "interrupted", reason: { kind: "network" }, bytesSent: 2 * PART });
    expect(calls.sent).toEqual([1, 2]);
    failing = false;
    calls.sent.length = 0;
    engine.retry(row.id);
    await flush();
    expect(engine.snapshot()[0]!.bytesSent).toBeGreaterThanOrEqual(2 * PART);
    await settle(clock, { timers: false });
    expect(calls.sent).toEqual([3, 4, 5]);
    expect(engine.snapshot()[0]).toMatchObject({ state: "processing", bytesSent: 33 * MIB });
    expect(calls.create).toBe(1);
    expect(calls.list).toBe(1);
  });

  it("completes on Retry when the server finished but the answer was lost", async () => {
    const { engine, clock, calls } = makeEngine({ loseFirstCompleteAnswer: true });
    engine.add([mp4File()]);
    await settle(clock, { timers: false });
    const row = engine.snapshot()[0]!;
    expect(row).toMatchObject({ state: "interrupted", reason: { kind: "network" } });
    engine.retry(row.id);
    await settle(clock, { timers: false });
    expect(calls.complete).toBe(2);
    expect(engine.snapshot()[0]).toMatchObject({ state: "processing", assetId: expect.stringContaining("asset-") });
  });

  it("re-signs once on a 403, then reports a storage refusal on the second", async () => {
    let first = true;
    const one = makeEngine({ send: () => (first ? ((first = false), { status: 403 }) : { status: 200 }) });
    one.engine.add([pngFile()]);
    await settle(one.clock, { timers: false });
    expect(states(one.engine)).toEqual(["processing"]);
    expect(one.calls.sign).toHaveLength(2);

    const two = makeEngine({ send: () => ({ status: 403 }) });
    two.engine.add([pngFile()]);
    await settle(two.clock, { timers: false });
    expect(two.engine.snapshot()[0]).toMatchObject({ state: "interrupted", reason: { kind: "storage" } });
    expect(two.calls.sign).toHaveLength(2);
  });

  it("words a 4xx from Docket and a lost session", async () => {
    const a = makeEngine({ send: () => ({ status: 409, message: "This upload has already finished." }) });
    a.engine.add([pngFile()]);
    await settle(a.clock, { timers: false });
    expect(a.engine.snapshot()[0]!.reason).toEqual({ kind: "docket", message: "This upload has already finished." });
  });

  it("cancels one file, calls cancelUpload for it, and leaves the others running (US1 AS7)", async () => {
    const gates: (() => void)[] = [];
    const { engine, clock, calls } = makeEngine({ send: () => new Promise((r) => gates.push(() => r({ status: 200 }))) });
    engine.add([pngFile("a.png"), pngFile("b.png")]);
    await flush();
    await flush();
    await flush();
    const [a, b] = engine.snapshot();
    engine.cancel(a!.id);
    expect(engine.snapshot()[0]!.state).toBe("cancelled");
    gates.splice(0).forEach((g) => g());
    await settle(clock, { timers: false });
    expect(calls.cancel).toEqual(["u1"]);
    expect(engine.snapshot().find((r) => r.id === b!.id)!.state).toBe("processing");
    expect(engine.snapshot()[0]!.state).toBe("cancelled");
  });

  it("follows processing to ready and to failed, and fails a row whose item was removed", async () => {
    const items: StatusItem<AssetLike>[] = [];
    const { engine, clock, events, calls } = makeEngine({ statusItems: () => items });
    engine.add([mp4File("a.mp4", 2 * MIB), mp4File("b.mp4", 2 * MIB), mp4File("c.mp4", 2 * MIB)]);
    await settle(clock, { timers: false });
    expect(states(engine)).toEqual(["processing", "processing", "processing"]);
    items.push(
      { id: "asset-u1", status: "processing", step: "probing", error: null, waitingForWorker: false, item: null },
      { id: "asset-u2", status: "failed", step: null, error: "Docket could not read this video.", waitingForWorker: false, item: null },
    );
    clock.runAll();
    await settle(clock, { timers: false });
    expect(engine.snapshot().map((r) => [r.state, r.step])).toEqual([
      ["processing", "probing"],
      ["failed", null],
      ["failed", null],
    ]);
    expect(engine.snapshot()[2]!.reason).toEqual({ kind: "deleted" });
    items.length = 0;
    items.push({ id: "asset-u1", status: "ready", step: null, error: null, waitingForWorker: false, item: { id: "asset-u1", status: "ready", processingStep: null, processingError: null } });
    clock.runAll();
    await settle(clock, { timers: false });
    expect(states(engine)).toEqual(["ready", "failed", "failed"]);
    expect(events.some((e) => e.type === "ready")).toBe(true);
    const polls = calls.status;
    clock.runAll();
    await settle(clock, { timers: false });
    expect(calls.status).toBe(polls); // nothing left to poll
  });

  it("is active while a row is checking, waiting, uploading or finishing, and idle after", async () => {
    const { engine, clock } = makeEngine({ completeStatus: "ready" });
    expect(engine.active()).toBe(false);
    engine.add([pngFile()]);
    expect(engine.active()).toBe(true);
    await settle(clock, { timers: false });
    expect(states(engine)).toEqual(["ready"]);
    expect(engine.active()).toBe(false);
  });

  it("notifies subscribers with a new snapshot on every change", async () => {
    const { engine, clock } = makeEngine();
    const fn = vi.fn();
    const off = engine.subscribe(fn);
    const before = engine.snapshot();
    engine.add([pngFile()]);
    expect(engine.snapshot()).not.toBe(before);
    await settle(clock, { timers: false });
    expect(fn.mock.calls.length).toBeGreaterThan(3);
    off();
  });
});
