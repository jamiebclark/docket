// services/engagement/prompt: the reply prompt (contracts/services.md §3, FR-020, FR-063).
import type { VoiceContent } from "../../../lib/validation/voice";
import type { BrandContext } from "../generation/prompt";

export const ITEM_TEXT_PROMPT_MAX = 4_000;

export interface ReplyPromptInput {
  voice: VoiceContent;
  brand: BrandContext | null;
  postingInstructions: string | null;
  /** The brand's own post, when it resolves; otherwise the comment stands alone. */
  parentText: string | null;
  itemText: string;
  itemTextTruncated: boolean;
  /**
   * What this prompt is allowed to say about who wrote the comment: a display name or handle, so
   * the reply can address them naturally. Nothing else about the author — no identifier, no URL,
   * no platform internals (FR-063).
   */
  author: { displayName: string | null; handle: string | null };
  platformName: string;
  maxLength: number;
  countingUnit: string;
}

function voiceSection(voice: VoiceContent): string {
  const parts: string[] = [];
  const field = (title: string, value: string) => {
    if (value.trim()) parts.push(`${title}:\n${value.trim()}`);
  };
  field("Voice and tone", voice.voiceAndTone);
  field("Audience", voice.audience);
  field("Avoid", voice.avoid);
  return `VOICE\n${parts.join("\n\n")}`;
}

function brandSection(brand: BrandContext): string {
  const parts: string[] = [];
  if (brand.tagline) parts.push(`Tagline: ${brand.tagline}`);
  if (brand.description) parts.push(`What it is:\n${brand.description}`);
  if (brand.websiteUrl) parts.push(`Website: ${brand.websiteUrl}`);
  return `BRAND\n${parts.join("\n\n")}`;
}

function who(author: ReplyPromptInput["author"]): string {
  const name = author.displayName ?? author.handle;
  return name ? `${name} wrote:` : "Someone wrote:";
}

/** Builds the reply prompt from the voice profile, brand identity, posting instructions, the brand's own parent post when known, and the item's bounded text (contracts/services.md §3). */
export function buildReplyPrompt(input: ReplyPromptInput): { system: string; user: string } {
  const sections = [voiceSection(input.voice)];
  if (input.brand) sections.push(brandSection(input.brand));
  if (input.postingInstructions) sections.push(`POSTING INSTRUCTIONS\n${input.postingInstructions.trim()}`);
  const system = [
    `You write one short reply to a comment on ${input.platformName}, in the brand's voice.`,
    ...sections,
    `RULES\n- At most ${input.maxLength} ${input.countingUnit}.\n- Write only the reply text. No quotation marks, no labels, no hashtags unless natural.\n- Be warm and specific. Do not invent facts about the commenter.`,
  ].join("\n\n");

  const itemText = input.itemText.slice(0, ITEM_TEXT_PROMPT_MAX);
  const userParts: string[] = [];
  if (input.parentText) userParts.push(`The original post said:\n"""\n${input.parentText}\n"""`);
  userParts.push(
    `${who(input.author)}\n"""\n${itemText}${input.itemTextTruncated || input.itemText.length > ITEM_TEXT_PROMPT_MAX ? "\n[truncated]" : ""}\n"""`,
  );
  userParts.push("Write the reply.");
  return { system, user: userParts.join("\n\n") };
}
