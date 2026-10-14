import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCases } from "./__fixtures__/cases";
import { buildSeriesPlanPrompt, platformRulesFor, promptGroupsFor } from "./prompt";
import { EMPTY_VOICE_CONTENT, type VoiceContent } from "@/lib/validation/voice";
import { groupTargets } from "@/lib/generation/groups";

// FR-009 / SC-003: one account per platform, no per-platform guidance => output identical to pre-011.
const golden = JSON.parse(readFileSync(join(__dirname, "__fixtures__/pre-011-prompts.json"), "utf8")) as Record<
  string,
  unknown
>;

describe("pre-011 golden prompts", () => {
  const actual = JSON.parse(JSON.stringify(buildCases())) as Record<string, unknown>;
  it("covers the same cases", () => expect(Object.keys(actual)).toEqual(Object.keys(golden)));
  for (const name of Object.keys(golden)) {
    it(name, () => expect(JSON.stringify(actual[name])).toBe(JSON.stringify(golden[name])));
  }
});

describe("buildSeriesPlanPrompt with avoidTitles (S31)", () => {
  const voice: VoiceContent = { ...EMPTY_VOICE_CONTENT, voiceAndTone: "Warm and plain." };
  const keys = ["bluesky"];
  const groups = promptGroupsFor(groupTargets(keys.map((k) => ({ id: k, providerKey: k, displayName: k, postingInstructions: null }))));
  const base = {
    voice,
    platforms: platformRulesFor(keys),
    groups,
    instructions: null,
    brief: "Announce the sale",
    sourceText: null,
    count: 3,
    retry: null,
  };

  it("is byte-identical to the empty case when avoidTitles is omitted", () => {
    const withOmitted = buildSeriesPlanPrompt(base);
    const withEmpty = buildSeriesPlanPrompt({ ...base, avoidTitles: [] });
    expect(withEmpty).toEqual(withOmitted);
  });

  it("appends one TITLES TO AVOID line when non-empty", () => {
    const { user } = buildSeriesPlanPrompt({ ...base, avoidTitles: ["First title", "Second title"] });
    expect(user).toContain("TITLES TO AVOID: First title, Second title");
  });
});
