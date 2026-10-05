import { describe, expect, it } from "vitest";
import { z } from "zod";
import { findProvider } from "../../../providers/registry";
import { groupTargets } from "@/lib/generation/groups";
import { groupsOfPlatforms } from "./__fixtures__/cases";
import type { MediaRow } from "../../dal/media";
import {
  checkGenerationOutput,
  checkSeriesPlan,
  generationOutputSchema,
  problemLine,
  seriesPlanSchema,
} from "./schema";

// No assets: the media repo is never consulted.
const scope = { media: {} } as never;

describe("generationOutputSchema", () => {
  it("has one required key per targeted platform", () => {
    const s = generationOutputSchema(["bluesky", "mock"], 0);
    expect(s.safeParse({ variants: { bluesky: { text: "a" }, mock: { text: "b" } } }).success).toBe(true);
    expect(s.safeParse({ variants: { bluesky: { text: "a" } } }).success).toBe(false);
    expect(s.safeParse({ variants: { bluesky: { text: "a" }, mock: { text: "b" }, x: { text: "c" } } }).success).toBe(false);
  });

  it("requires alt texts only when images are attached, and sends no constraints", () => {
    const withImages = z.toJSONSchema(generationOutputSchema(["bluesky"], 2) as z.ZodType) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(withImages.required).toEqual(["variants", "imageAltTexts"]);
    for (const schema of [generationOutputSchema(["bluesky"], 2), seriesPlanSchema]) {
      const json = JSON.stringify(z.toJSONSchema(schema as z.ZodType));
      for (const banned of ["maxLength", "minItems", "anyOf", "minLength"]) expect(json).not.toContain(banned);
    }
    const none = z.toJSONSchema(generationOutputSchema(["bluesky"], 0) as z.ZodType) as { required: string[] };
    expect(none.required).toEqual(["variants"]);
  });
});

describe("grouped output", () => {
  const acct = (id: string, name: string, postingInstructions: string | null) => ({
    id,
    displayName: name,
    providerKey: "bluesky",
    postingInstructions,
  });
  const groups = groupTargets([acct("1", "Acme Science", "a"), acct("2", "Acme News", "b")]);

  it("builds one required key per group, with no optional or union parameters", () => {
    const json = JSON.stringify(z.toJSONSchema(generationOutputSchema(groups.map((g) => g.key), 0) as z.ZodType));
    expect(json).toContain("bluesky_1");
    expect(json).toContain("bluesky_2");
    expect(json).not.toContain("anyOf");
    expect(json).not.toContain("oneOf");
    const parsed = JSON.parse(json) as { properties: { variants: { required: string[]; properties: object } } };
    expect(parsed.properties.variants.required).toEqual(["bluesky_1", "bluesky_2"]);
    expect(Object.keys(parsed.properties.variants.properties)).toEqual(["bluesky_1", "bluesky_2"]);
  });

  it("names the group and accounts in problem lines for split platforms only", async () => {
    const r = await checkGenerationOutput(scope, {
      groups,
      assets: [],
      output: { variants: { bluesky_1: { text: "ok" }, bluesky_2: { text: "a".repeat(312) } } },
    });
    expect(r.problems.map(problemLine)).toEqual([
      "bluesky_2 (Bluesky: Acme News): Text is 312 graphemes; the limit is 300.",
    ]);
    expect(r.problems[0]).toMatchObject({ groupKey: "bluesky_2", providerKey: "bluesky" });
  });
});

describe("checkGenerationOutput", () => {
  it("reports an empty post", async () => {
    const r = await checkGenerationOutput(scope, {
      groups: groupsOfPlatforms(["bluesky"]),
      assets: [],
      output: { variants: { bluesky: { text: "  " } } },
    });
    expect(r.problems.map(problemLine)).toEqual(["bluesky: The post is empty."]);
  });

  it("reports the provider's own over-limit message", async () => {
    const r = await checkGenerationOutput(scope, {
      groups: groupsOfPlatforms(["bluesky"]),
      assets: [],
      output: { variants: { bluesky: { text: "a".repeat(312) } } },
    });
    expect(r.problems.map(problemLine)).toEqual(["bluesky: Text is 312 graphemes; the limit is 300."]);
  });

  it("passes a valid post with no problems", async () => {
    const r = await checkGenerationOutput(scope, {
      groups: groupsOfPlatforms(["bluesky"]),
      assets: [],
      output: { variants: { bluesky: { text: "hello" } } },
    });
    expect(r.problems).toEqual([]);
  });
  const asset = { id: "a", mimeType: "image/jpeg", width: 800, height: 800, byteSize: 50_000, altText: "", storageKey: "k", publicUrl: "https://x.test/a.jpg" } as MediaRow;
  const withAlts = (imageAltTexts: string[]) =>
    checkGenerationOutput(scope, {
      groups: groupsOfPlatforms(["bluesky"]),
      assets: [asset],
      output: { variants: { bluesky: { text: "x" } }, imageAltTexts },
    });

  it("checks the alt text count", async () => {
    expect((await withAlts([])).problems.map(problemLine)).toEqual(["Write exactly 1 alt texts, one per image."]);
    expect((await withAlts(["a dog"])).problems).toEqual([]);
  });

  it("checks the alt text length against the strictest platform", async () => {
    const limit = findProvider("bluesky")!.capabilities.media.maxAltTextLength;
    if (limit === undefined) return;
    const r = await withAlts(["a".repeat(limit + 1)]);
    expect(r.problems.map(problemLine)).toEqual([`Alt text 1 is ${limit + 1} characters; the limit is ${limit}.`]);
  });
});

describe("checkSeriesPlan", () => {
  const ok = { angles: [{ title: "A", description: "d" }, { title: "B", description: "d" }] };
  it("accepts a good plan", () => expect(checkSeriesPlan(ok, 2)).toEqual([]));
  it("checks the count", () =>
    expect(checkSeriesPlan(ok, 3).map(problemLine)).toEqual(["Expected 3 angles, got 2."]));
  it("checks lengths", () => {
    const p = checkSeriesPlan({ angles: [{ title: "", description: "x".repeat(301) }, ok.angles[1]!] }, 2).map(problemLine);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatch(/^Angle 1:/);
  });
  it("detects duplicates after case-folding", () =>
    expect(
      checkSeriesPlan({ angles: [{ title: " Hello ", description: "d" }, { title: "hello", description: "d" }] }, 2).map(problemLine),
    ).toEqual(["Angles 1 and 2 are the same."]));
});
