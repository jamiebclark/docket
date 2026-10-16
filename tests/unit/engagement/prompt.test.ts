import { describe, expect, it } from "vitest";
import { EMPTY_VOICE_CONTENT } from "../../../src/lib/validation/voice";
import { buildReplyPrompt } from "../../../src/server/services/engagement/prompt";

const baseInput = {
  voice: { ...EMPTY_VOICE_CONTENT, voiceAndTone: "Friendly", audience: "Everyone" },
  brand: null,
  postingInstructions: null,
  parentText: null,
  itemText: "Love this!",
  itemTextTruncated: false,
  platformName: "Bluesky",
  maxLength: 300,
  countingUnit: "characters",
} as const;

describe("buildReplyPrompt author exposure", () => {
  it("carries the commenter's display name and nothing else about them", () => {
    const { user } = buildReplyPrompt({
      ...baseInput,
      author: { displayName: "Jordan Rivera", handle: "jrivera.bsky.social" },
    });
    expect(user).toContain("Jordan Rivera wrote:");
    expect(user).not.toContain("jrivera.bsky.social");
  });

  it("falls back to the handle when there is no display name", () => {
    const { user } = buildReplyPrompt({
      ...baseInput,
      author: { displayName: null, handle: "jrivera.bsky.social" },
    });
    expect(user).toContain("jrivera.bsky.social wrote:");
  });

  it("names neither when the author has no name or handle", () => {
    const { user } = buildReplyPrompt({
      ...baseInput,
      author: { displayName: null, handle: null },
    });
    expect(user).toContain("Someone wrote:");
  });
});
