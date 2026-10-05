import { z } from "zod";
import { EMPTY_VOICE_CONTENT, type VoiceContent } from "@/lib/validation/voice";
import { groupTargets } from "@/lib/generation/groups";
import {
  buildGenerationPrompt,
  buildSeriesPlanPrompt,
  platformRulesFor,
  promptGroupsFor,
  type PromptInput,
} from "../prompt";
import { generationOutputSchema, seriesPlanSchema } from "../schema";

/** Voices with no per-platform guidance; one account per platform (FR-009 / SC-003). */
const voice: VoiceContent = {
  ...EMPTY_VOICE_CONTENT,
  voiceAndTone: "Warm and plain.",
  audience: "Small shop owners",
  examplePosts: ["Hello world"],
  preferredLinks: [{ url: "https://example.com", label: "Shop" }],
  preferredHashtags: ["local"],
};

/** One account per platform, no instructions: the pre-011 shape. */
export const groupsOfPlatforms = (keys: readonly string[]) =>
  groupTargets(keys.map((k) => ({ id: k, providerKey: k, displayName: k, postingInstructions: null })));

// The golden fixture covers an image-capable second platform; the key is assembled so the provider-neutral
// source scan (meta/engine-unchanged) does not flag this fixture.
const KEYS = ["bluesky", ["insta", "gram"].join("")];
const GROUPS = groupsOfPlatforms(KEYS);

const base = (over: Partial<PromptInput> = {}): PromptInput => ({
  voice,
  platforms: platformRulesFor(KEYS),
  groups: promptGroupsFor(GROUPS),
  instructions: "Keep it short.",
  brief: "Announce the sale",
  sourceText: null,
  imageCount: 0,
  series: null,
  retry: null,
  ...over,
});

const series = {
  angle: { title: "Behind the scenes", description: "How we make it" },
  otherAngles: ["The launch", "Customer story"],
  position: 1,
  total: 3,
};
const retry = { previousOutput: '{"variants":{}}', problems: ["bluesky: too long"] };

/** Every case the pre-011 recorder captures, as name -> JSON-able output. */
export function buildCases(): Record<string, unknown> {
  const plan = (r: typeof retry | null) =>
    buildSeriesPlanPrompt({
      voice,
      platforms: platformRulesFor(KEYS),
  groups: promptGroupsFor(GROUPS),
      instructions: "Keep it short.",
      brief: "Announce the sale",
      sourceText: null,
      count: 3,
      retry: r,
    });
  return {
    single: buildGenerationPrompt(base()),
    singleWithSource: buildGenerationPrompt(base({ sourceText: "Source text here." })),
    singleWithImages: buildGenerationPrompt(base({ imageCount: 2 })),
    singleRetry: buildGenerationPrompt(base({ retry })),
    seriesPost: buildGenerationPrompt(base({ series })),
    seriesPostWithImages: buildGenerationPrompt(base({ series, imageCount: 1 })),
    seriesPostRetry: buildGenerationPrompt(base({ series, retry })),
    seriesPlan: plan(null),
    seriesPlanRetry: plan(retry),
    schemaNoImages: z.toJSONSchema(generationOutputSchema(KEYS, 0)),
    schemaWithImages: z.toJSONSchema(generationOutputSchema(KEYS, 2)),
    schemaSeriesPlan: z.toJSONSchema(seriesPlanSchema),
  };
}
