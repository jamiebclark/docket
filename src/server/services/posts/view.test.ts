import { describe, expect, it } from "vitest";
import { preparingVideoLabel } from "./view";

describe("preparingVideoLabel", () => {
  it("names the provider", () => {
    expect(preparingVideoLabel("Facebook")).toBe("Preparing video for Facebook");
  });
});
