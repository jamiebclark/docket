import { describe, expect, it } from "vitest";
import { readQuota } from "./quota";

describe("readQuota", () => {
  it("reads usage and total from data[0]", () => {
    expect(readQuota({ data: [{ quota_usage: 4, config: { quota_total: 250, quota_duration: 86400 } }] })).toEqual({ usage: 4, total: 250 });
  });

  it("is unknown for anything else", () => {
    const bad = [
      null,
      undefined,
      "x",
      {},
      { data: [] },
      { data: [null] },
      { data: "x" },
      { data: [{ quota_usage: 1 }] },
      { data: [{ config: { quota_total: 250 } }] },
      { data: [{ quota_usage: "1", config: { quota_total: 250 } }] },
      { data: [{ quota_usage: 1, config: { quota_total: 0 } }] },
      { data: [{ quota_usage: 1, config: null }] },
      { data: [{ quota_usage: Number.NaN, config: { quota_total: 250 } }] },
    ];
    for (const b of bad) expect(readQuota(b)).toBeNull();
  });
});
