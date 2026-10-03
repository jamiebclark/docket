import { describe, expect, it } from "vitest";
import { nextRetryAt } from "./backoff";

const NOW = new Date("2026-10-05T09:00:00Z");
const cfg = { backoffBaseMs: 60_000, backoffMaxMs: 600_000 };
const delay = (at: Date) => at.getTime() - NOW.getTime();

describe("nextRetryAt", () => {
  it("doubles the delay with each attempt", () => {
    expect(delay(nextRetryAt(NOW, 1, cfg))).toBe(60_000);
    expect(delay(nextRetryAt(NOW, 2, cfg))).toBe(120_000);
    expect(delay(nextRetryAt(NOW, 3, cfg))).toBe(240_000);
    expect(delay(nextRetryAt(NOW, 4, cfg))).toBe(480_000);
  });

  it("caps the delay", () => {
    expect(delay(nextRetryAt(NOW, 5, cfg))).toBe(600_000);
    expect(delay(nextRetryAt(NOW, 500, cfg))).toBe(600_000);
  });

  it("treats a zero attempt count as the first delay", () => {
    expect(delay(nextRetryAt(NOW, 0, cfg))).toBe(60_000);
  });

  it("never schedules earlier than the provider's notBefore", () => {
    const later = new Date(NOW.getTime() + 3_600_000);
    expect(nextRetryAt(NOW, 1, cfg, later)).toEqual(later);
  });

  it("keeps the backoff when it is later than notBefore", () => {
    const sooner = new Date(NOW.getTime() + 1_000);
    expect(delay(nextRetryAt(NOW, 2, cfg, sooner))).toBe(120_000);
  });
});
