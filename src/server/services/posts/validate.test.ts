import { describe, expect, it } from "vitest";
import { findProvider } from "../../../providers/registry";
import type { ProjectScope } from "../../dal/scope";
import { validateResolvedContent, validateTargetContent } from "./validate";

describe("validateResolvedContent", () => {
  it("gives the scheduling gate and the publish engine identical messages", async () => {
    const provider = findProvider("bluesky")!;
    const text = "x".repeat(5000);
    const fromEngine = validateResolvedContent(provider, { text, media: [] });
    const fromGate = await validateTargetContent(
      {} as Pick<ProjectScope, "media">,
      { providerKey: "bluesky" },
      { text, assets: [], referenced: 0 },
    );
    expect(fromEngine.some((i) => i.severity === "error")).toBe(true);
    expect(fromGate?.map((i) => i.message)).toEqual(fromEngine.map((i) => i.message));
  });

  it("returns nothing for content the provider accepts", () => {
    expect(validateResolvedContent(findProvider("bluesky")!, { text: "hello", media: [] })).toEqual([]);
  });
});
