import { describe, expect, it } from "vitest";
import type { PlatformFit } from "@/server/services/media-fit";
import { fitNote, fitText, fitTone } from "./fit-ui";

const fit = (state: PlatformFit["state"], details: string[] = []): PlatformFit => ({
  providerKey: "instagram",
  providerName: "Instagram",
  state,
  steps: [],
  details,
  convertedTo: null,
});

describe("fit wording", () => {
  it("names the platform and the outcome", () => {
    expect(fitText(fit("fits"))).toBe("Instagram: fits");
    expect(fitText(fit("converted"))).toBe("Instagram: will be converted");
    expect(fitText(fit("refused"))).toBe("Instagram: will be refused");
  });
  it("tones each state", () => {
    expect([fitTone("fits"), fitTone("converted"), fitTone("refused")]).toEqual(["success", "info", "danger"]);
  });
  it("writes a note line only for non-fitting platforms", () => {
    expect(fitNote(fit("fits"))).toBeNull();
    expect(fitNote(fit("converted", ["This image will be converted to JPEG for Instagram."]))).toBe(
      "Instagram: This image will be converted to JPEG for Instagram.",
    );
    expect(fitNote(fit("refused", ["A.", "B."]))).toBe("Instagram: A. B.");
  });
});
