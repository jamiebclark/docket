import { describe, expect, it } from "vitest";
import { ratioLabel, videoBytesLabel } from "./video-labels";

describe("ratioLabel", () => {
  it("keeps the a:b form for small exact fractions", () => {
    expect(ratioLabel(9 / 16)).toBe("9:16");
    expect(ratioLabel(16 / 9)).toBe("16:9");
    expect(ratioLabel(10)).toBe("10:1");
  });
  it("uses 1:n for tiny ratios whose inverse is whole", () => {
    expect(ratioLabel(0.01)).toBe("1:100");
    expect(ratioLabel(1 / 1000)).toBe("1:1000");
    expect(`${ratioLabel(0.01)} – ${ratioLabel(10)}`).toBe("1:100 – 10:1");
  });
  it("falls back to r:1 otherwise", () => {
    expect(ratioLabel(1.91)).toBe("1.91:1");
    expect(ratioLabel(0.013)).toBe("0.01:1");
  });
});

describe("videoBytesLabel", () => {
  it("uses decimal gigabytes from 1 GB up and megabytes below", () => {
    expect(videoBytesLabel(1e9)).toBe("1 GB");
    expect(videoBytesLabel(1.05e9)).toBe("1.05 GB");
    expect(videoBytesLabel(300e6)).toBe("300 MB");
    expect(videoBytesLabel(50e6)).toBe("50 MB");
  });
});
