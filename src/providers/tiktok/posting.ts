import { z } from "zod";
import { docsUrl } from "@/lib/docs";
import type { ConsentDeclaration, PostingDeclaration, PostingFieldView, PostingOptionView, PostType } from "../types";
import { TIKTOK_TEXT_RULE } from "./capabilities";
import { tiktokAudited } from "./config";
import type { CreatorDetails } from "./creator";
import { PHOTO_DOMAIN_NOTE } from "./settings";

export const PHOTO_TITLE_MAX = 90;
export const PRIVATE_PRIVACY = "SELF_ONLY";

/**
 * Data-model §3. Every member but `v` defaults, so the composer can send only what a person changed and the service stores a
 * complete record. Turning the disclosure off clears the brand boxes it hides.
 */
export const tiktokPostingSchema = z
  .object({
    v: z.literal(1).default(1),
    /** Null = not chosen. */
    privacy: z.string().regex(/^[A-Z_]{1,40}$/).nullable().default(null),
    allowComments: z.boolean().default(false),
    /** Ignored for photo posts. */
    allowDuets: z.boolean().default(false),
    allowStitches: z.boolean().default(false),
    disclosure: z.boolean().default(false),
    yourBrand: z.boolean().default(false),
    brandedContent: z.boolean().default(false),
    /** Validated to at most 90 UTF-16 units; "" = none. */
    photoTitle: z.string().max(400).default(""),
  })
  .transform((v) => (v.disclosure ? v : { ...v, yourBrand: false, brandedContent: false }));

export type TikTokPostingValues = z.output<typeof tiktokPostingSchema>;

export const DEFAULT_POSTING_VALUES: TikTokPostingValues = {
  v: 1,
  privacy: null,
  allowComments: false,
  allowDuets: false,
  allowStitches: false,
  disclosure: false,
  yourBrand: false,
  brandedContent: false,
  photoTitle: "",
};

// Research P21.
const PRIVACY_LABELS: Readonly<Record<string, string>> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends (mutual followers)",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};

/** The plain word for a privacy level; an unknown level shows as its code. */
export function privacyLabel(code: string): string {
  return PRIVACY_LABELS[code] ?? code;
}

export const BRANDED_PRIVATE_REASON = "Branded content can't be private.";
export const BRANDED_UNAUDITED_REASON = "Branded content can't be private, and this app can only post privately.";
export const INTERACTION_OFF_REASON = "Turned off in this TikTok account's settings.";
export const AFTER_PREVIEW = "It may take a few minutes for the post to process and be visible on TikTok.";

const isVideo = (postType: PostType): boolean => postType === "video";

function privacyField(values: TikTokPostingValues, details: CreatorDetails | null, audited: boolean): PostingFieldView {
  if (!audited) {
    return {
      key: "privacy",
      label: "Who can see this",
      kind: "fixed",
      value: PRIVATE_PRIVACY,
      display: "Only me (private)",
      explanation: "This TikTok app hasn't passed TikTok's audit, so every post is private. The TikTok account must also be set to private.",
      doc: docsUrl("tiktok-setup", "unaudited-apps"),
    };
  }
  const options: PostingOptionView[] = (details?.privacyOptions ?? []).map((code) => ({
    value: code,
    label: privacyLabel(code),
    ...(code === PRIVATE_PRIVACY && values.brandedContent ? { disabled: { reason: BRANDED_PRIVATE_REASON } } : {}),
  }));
  return { key: "privacy", label: "Who can see this", kind: "choice", value: values.privacy, options, required: true, placeholder: "Choose…" };
}

function toggle(key: string, label: string, value: boolean, disabledReason: string | null): PostingFieldView {
  return { key, label, kind: "toggle", value, ...(disabledReason ? { disabled: { reason: disabledReason } } : {}) };
}

/** Pure and total (G25). Unaudited installs show a fixed private level and a disabled "Branded content". */
function view({ values, details, postType }: { values: TikTokPostingValues | null; details: CreatorDetails | null; postType: PostType }): PostingFieldView[] {
  const v = values ?? DEFAULT_POSTING_VALUES;
  const audited = tiktokAudited();
  const off = (disabled: boolean | undefined) => (disabled ? INTERACTION_OFF_REASON : null);
  const fields: PostingFieldView[] = [privacyField(v, details, audited)];
  fields.push(toggle("allowComments", "Allow comments", v.allowComments, off(details?.commentDisabled)));
  if (isVideo(postType)) {
    fields.push(toggle("allowDuets", "Allow duets", v.allowDuets, off(details?.duetDisabled)));
    fields.push(toggle("allowStitches", "Allow stitches", v.allowStitches, off(details?.stitchDisabled)));
  } else {
    fields.push({
      key: "photoTitle",
      label: "Photo title",
      kind: "text",
      value: v.photoTitle,
      maxLength: PHOTO_TITLE_MAX,
      countingRule: TIKTOK_TEXT_RULE,
      optional: true,
    });
  }
  fields.push(toggle("disclosure", "Disclose commercial content", v.disclosure, null));
  if (v.disclosure) {
    fields.push(toggle("yourBrand", "Your brand", v.yourBrand, null));
    fields.push(toggle("brandedContent", "Branded content", v.brandedContent, audited ? null : BRANDED_UNAUDITED_REASON));
  }
  return fields;
}

function heading(details: CreatorDetails | null): string | null {
  const name = details?.nickname || details?.username;
  return name ? `Posting to ${name}` : null;
}

function notice(): { text: string; doc?: string } | null {
  if (tiktokAudited()) return null;
  return {
    text: "This TikTok app hasn't passed TikTok's audit, so it can only post privately.",
    doc: docsUrl("tiktok-setup", "unaudited-apps"),
  };
}

function targetNote(values: TikTokPostingValues | null): string | null {
  if (values ? values.privacy === PRIVATE_PRIVACY : !tiktokAudited()) return "Private on TikTok";
  return null;
}

function summaryNotes(): string[] {
  const notes: string[] = [];
  if (!tiktokAudited()) {
    notes.push(
      "Posts are private: this TikTok app hasn't passed TikTok's audit. The TikTok account must also be set to private, and at most 5 accounts can post through this app in 24 hours.",
    );
  }
  notes.push(PHOTO_DOMAIN_NOTE);
  notes.push("Videos also must fit the TikTok account's own maximum length, checked when you agree and again when the post goes out.");
  notes.push("About 15 posts per account per day, shared with other apps that post to TikTok.");
  return notes;
}

export const tiktokPosting: PostingDeclaration<TikTokPostingValues, CreatorDetails> = {
  valuesSchema: tiktokPostingSchema,
  view,
  heading,
  notice,
  targetNote,
  summaryNotes,
  afterPreview: AFTER_PREVIEW,
};

/** Research P22. */
export const tiktokConsent: ConsentDeclaration<TikTokPostingValues> = {
  declaration: (values) =>
    values?.brandedContent
      ? "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation."
      : "By posting, you agree to TikTok's Music Usage Confirmation.",
};
