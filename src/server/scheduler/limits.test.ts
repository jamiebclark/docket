import { describe, expect, it } from "vitest";
import { deferralTime, effectiveLimits } from "./limits";

const none = { publishLimitCount: null, publishLimitWindowSeconds: null };
const at = (s: string) => new Date(`2026-01-01T${s}Z`);

describe("effectiveLimits", () => {
  it("returns nothing when neither is set", () => {
    expect(effectiveLimits(undefined, none)).toEqual([]);
  });
  it("returns both so the stricter applies", () => {
    expect(
      effectiveLimits({ count: 100, windowSeconds: 86400 }, { publishLimitCount: 2, publishLimitWindowSeconds: 3600 }),
    ).toEqual([
      { count: 100, windowSeconds: 86400 },
      { count: 2, windowSeconds: 3600 },
    ]);
  });
  it("ignores a half-set account limit", () => {
    expect(effectiveLimits(undefined, { publishLimitCount: 2, publishLimitWindowSeconds: null })).toEqual([]);
  });
});

describe("deferralTime", () => {
  const now = at("12:00:00");
  it("is null under the limit", async () => {
    expect(await deferralTime([{ count: 2, windowSeconds: 3600 }], now, async () => [at("11:30:00")])).toBeNull();
  });
  it("is the oldest start plus the window at the limit", async () => {
    const r = await deferralTime([{ count: 2, windowSeconds: 3600 }], now, async () => [at("11:40:00"), at("11:10:00")]);
    expect(r).toEqual(at("12:10:00"));
  });
  it("takes the later deferral when both limits bind", async () => {
    const r = await deferralTime(
      [
        { count: 1, windowSeconds: 3600 },
        { count: 1, windowSeconds: 7200 },
      ],
      now,
      async (since) => [at("10:30:00"), at("11:30:00")].filter((d) => d > since),
    );
    expect(r).toEqual(at("12:30:00"));
  });
  it("is null with no limits", async () => {
    expect(await deferralTime([], now, async () => [now])).toBeNull();
  });
});
