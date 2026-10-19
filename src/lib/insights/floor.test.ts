import { describe, expect, it } from "vitest";
import { PROVISIONAL_MIN, RANK_MIN, verdictFor } from "./floor";

describe("verdictFor", () => {
  it("suppresses below the provisional floor", () => {
    expect(verdictFor(0)).toBe("suppressed");
    expect(verdictFor(3)).toBe("suppressed");
  });

  it("is provisional from 4 up to 7", () => {
    expect(verdictFor(PROVISIONAL_MIN)).toBe("provisional");
    expect(verdictFor(4)).toBe("provisional");
    expect(verdictFor(7)).toBe("provisional");
  });

  it("ranks at 8 and above", () => {
    expect(verdictFor(RANK_MIN)).toBe("ranked");
    expect(verdictFor(8)).toBe("ranked");
    expect(verdictFor(1000)).toBe("ranked");
  });
});
