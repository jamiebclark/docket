import type { VoiceContent } from "@/lib/validation/voice";

export const EXAMPLES_MAX = 10;
export const LINKS_MAX = 20;
export const FIELD_MAX = 2000;

export interface VoiceFormState {
  name: string;
  voiceAndTone: string;
  audience: string;
  topicsAndPillars: string;
  avoid: string;
  examplePosts: string[];
  preferredLinks: { url: string; label: string }[];
  /** Typed as one line; normalised on blur. */
  hashtags: string;
  platformGuidance: Record<string, string>;
}

export function toFormState(name: string, c: VoiceContent): VoiceFormState {
  return {
    name,
    voiceAndTone: c.voiceAndTone,
    audience: c.audience,
    topicsAndPillars: c.topicsAndPillars,
    avoid: c.avoid,
    examplePosts: [...c.examplePosts],
    preferredLinks: c.preferredLinks.map((l) => ({ ...l })),
    hashtags: c.preferredHashtags.map((t) => `#${t}`).join(" "),
    platformGuidance: { ...c.platformGuidance },
  };
}

/** `#Tag, tag  other` → `#Tag #other`: split on commas and spaces, one leading `#`, duplicates dropped. */
export function normaliseHashtags(raw: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const tag = part.replace(/^#+/, "");
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(`#${tag}`);
  }
  return out.join(" ");
}

/** The unvalidated content the server parses; blank rows are dropped there. */
export function toContent(s: VoiceFormState) {
  return {
    voiceAndTone: s.voiceAndTone,
    audience: s.audience,
    topicsAndPillars: s.topicsAndPillars,
    avoid: s.avoid,
    examplePosts: s.examplePosts,
    preferredLinks: s.preferredLinks.filter((l) => l.url.trim() !== ""),
    preferredHashtags: normaliseHashtags(s.hashtags)
      .split(" ")
      .filter(Boolean),
    platformGuidance: s.platformGuidance,
  };
}
