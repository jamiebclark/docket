import { describe, expect, it } from "vitest";
import { BANNER_NOTICE_TTL_MS, MAX_BANNER_MESSAGE, openBannerMessage, sealBannerMessage } from "./connect-banner";

const target = { projectSlug: "acme", groupKey: "x", code: "exchange_failed" };
const now = new Date("2026-10-07T12:00:00Z");

describe("connect banner notices (G18)", () => {
  it("round-trips a message for the same target", () => {
    const notice = sealBannerMessage(target, "X could not be reached. Nothing changed.", now)!;
    expect(notice).not.toContain("reached");
    expect(openBannerMessage(target, notice, now)).toBe("X could not be reached. Nothing changed.");
  });

  it.each([
    ["another project", { ...target, projectSlug: "other" }],
    ["another group", { ...target, groupKey: "meta" }],
    ["another code", { ...target, code: "cancelled" }],
  ])("does not open for %s", (_, other) => {
    expect(openBannerMessage(other, sealBannerMessage(target, "hello", now)!, now)).toBeNull();
  });

  it("expires", () => {
    const notice = sealBannerMessage(target, "hello", now)!;
    expect(openBannerMessage(target, notice, new Date(now.getTime() + BANNER_NOTICE_TTL_MS - 1))).toBe("hello");
    expect(openBannerMessage(target, notice, new Date(now.getTime() + BANNER_NOTICE_TTL_MS + 1))).toBeNull();
  });

  it("refuses forged, tampered, empty and oversized input", () => {
    const notice = sealBannerMessage(target, "hello", now)!;
    expect(openBannerMessage(target, "Your account is suspended, call 555-0100", now)).toBeNull();
    expect(openBannerMessage(target, notice.slice(0, -2) + (notice.endsWith("AA") ? "BB" : "AA"), now)).toBeNull();
    expect(openBannerMessage(target, "x".repeat(2001), now)).toBeNull();
    expect(sealBannerMessage(target, "", now)).toBeNull();
    expect(sealBannerMessage(target, "a".repeat(MAX_BANNER_MESSAGE + 1), now)).toBeNull();
  });
});
