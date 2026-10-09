import { describe, expect, it } from "vitest";
import { chunkPlan, chunkRange, creatorState, fitState, nextReadAt, parseTikTokState } from "./state";

describe("chunkPlan (data-model §7, SC-006)", () => {
  it.each([
    [4_000_000, 4_000_000, 1, 4_000_000],
    [8_000_000, 8_000_000, 1, 8_000_000],
    [20_000_000, 5_242_880, 3, 9_514_240],
    [157_286_400, 5_242_880, 30, 5_242_880],
    [1_073_741_824, 35_791_394, 30, 35_791_398],
    [1_920_000_000, 64_000_000, 30, 64_000_000],
    [4_000_000_000, 64_000_000, 62, 96_000_000],
  ])("%i bytes", (size, chunkSize, chunkCount, finalSize) => {
    expect(chunkPlan(size)).toEqual({ chunkSize, chunkCount, finalSize });
  });

  it("refuses an empty, fractional or oversize file", () => {
    expect(chunkPlan(0)).toBeNull();
    expect(chunkPlan(1.5)).toBeNull();
    expect(chunkPlan(4_000_000_001)).toBeNull();
  });

  it("covers the whole file with contiguous ranges", () => {
    const size = 20_000_000;
    const plan = chunkPlan(size)!;
    expect(chunkRange(plan, size, 1)).toEqual({ first: 0, last: 5_242_879 });
    expect(chunkRange(plan, size, 2)).toEqual({ first: 5_242_880, last: 10_485_759 });
    expect(chunkRange(plan, size, 3)).toEqual({ first: 10_485_760, last: size - 1 });
  });
});

const chunks = {
  v: 1,
  kind: "video",
  phase: "chunks",
  restarts: 0,
  nickname: "Ada",
  fileUrl: "https://media.test/v.mp4",
  fileBytes: 20_000_000,
  chunkSize: 5_242_880,
  chunkCount: 3,
  chunksSent: 1,
  publishId: "v_pub_1",
  sealedUploadUrl: "a.b.c",
  uploadIssuedAt: "2026-01-01T00:00:00.000Z",
};

describe("parseTikTokState", () => {
  it("reads each phase", () => {
    expect(parseTikTokState({ v: 1, kind: "photo", phase: "creator", restarts: 0 })).not.toBeNull();
    expect(parseTikTokState({ v: 1, kind: "photo", phase: "start", restarts: 0, nickname: "A" })).not.toBeNull();
    expect(parseTikTokState(chunks)).not.toBeNull();
    expect(parseTikTokState({ v: 1, kind: "photo", phase: "status", restarts: 0, publishId: "p", sentAt: "2026-01-01T00:00:00.000Z" })).not.toBeNull();
  });

  it.each([
    ["null", null],
    ["start without nickname", { v: 1, kind: "photo", phase: "start", restarts: 0 }],
    ["status without sentAt", { v: 1, kind: "photo", phase: "status", restarts: 0, publishId: "p" }],
    ["chunks for a photo", { ...chunks, kind: "photo" }],
    ["chunksSent past the end", { ...chunks, chunksSent: 3 }],
    ["a plan that does not match the size", { ...chunks, chunkCount: 2 }],
    ["chunks without an address", { ...chunks, sealedUploadUrl: undefined }],
    ["too many restarts", { v: 1, kind: "video", phase: "creator", restarts: 3 }],
  ])("rejects %s", (_n, value) => {
    expect(parseTikTokState(value)).toBeNull();
  });
});

describe("fitState (P33)", () => {
  const s = parseTikTokState(chunks)!;
  it("keeps a state whose file matches", () => {
    expect(fitState(s, { kind: "video", url: "https://media.test/v.mp4", bytes: 20_000_000 })).toBe(s);
  });
  it("restarts when the file or kind changed", () => {
    expect(fitState(s, { kind: "video", url: "https://media.test/v.mp4", bytes: 1 })).toEqual(creatorState("video", 0));
    expect(fitState(s, { kind: "photo" })).toEqual(creatorState("photo", 0));
  });
  it("never restarts after publishing", () => {
    const after = { v: 1, kind: "video", phase: "status", restarts: 1, publishId: "p", sentAt: "2026-01-01T00:00:00.000Z" } as const;
    expect(fitState(after, { kind: "photo" })).toBe(after);
  });
});

describe("nextReadAt (P30)", () => {
  const sentAt = "2026-01-01T00:00:00.000Z";
  const t = (ms: number) => new Date(Date.parse(sentAt) + ms).toISOString();
  it("first read after 15 seconds", () => {
    expect(nextReadAt({ sentAt }).toISOString()).toBe(t(15_000));
  });
  it("then a minute apart for ten minutes, then five", () => {
    expect(nextReadAt({ sentAt, lastReadAt: t(15_000) }).toISOString()).toBe(t(75_000));
    expect(nextReadAt({ sentAt, lastReadAt: t(10 * 60_000) }).toISOString()).toBe(t(15 * 60_000));
  });
  it("lands on the 60-minute ceiling", () => {
    expect(nextReadAt({ sentAt, lastReadAt: t(58 * 60_000) }).toISOString()).toBe(t(60 * 60_000));
  });
});
