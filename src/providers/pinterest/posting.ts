import { z } from "zod";
import { docsUrl } from "@/lib/docs";
import type { PostingDeclaration, PostingFieldView, PostingOptionView } from "../types";
import type { PinterestDetails } from "./boards";
import { PINTEREST_TRIAL_TEXT } from "./settings";

const SETUP = docsUrl("pinterest-setup");

/** data-model §4 (G25). Every member defaults, so the composer can send only what a person touched. */
export const pinterestPostingSchema = z.object({
  v: z.literal(1).default(1),
  boardId: z.string().min(1).max(100).nullable().default(null),
  boardName: z.string().max(400).default(""),
  title: z.string().max(400).default(""),
  link: z.string().max(4096).default(""),
});

export type PinterestPostingValues = z.infer<typeof pinterestPostingSchema>;

export const DEFAULT_POSTING_VALUES: PinterestPostingValues = { v: 1, boardId: null, boardName: "", title: "", link: "" };

export const PINTEREST_TITLE_MAX = 100;
export const PINTEREST_LINK_MAX = 2048;

const BOARDS_LOADING_REASON = "Pinterest's boards are still loading.";
const NO_BOARDS_REASON = "This Pinterest account has no public boards. Create one on Pinterest, then choose it here.";

function boardOption(id: string, name: string): PostingOptionView {
  return { value: id, label: name };
}

/** The board `choice` field (data-model §5). Pure, total. */
function boardField(values: PinterestPostingValues, details: PinterestDetails | null): PostingFieldView {
  const common = { key: "boardId", label: "Board", kind: "choice" as const, value: values.boardId, required: true, placeholder: "Choose a board…", labelKey: "boardName" };
  if (!details) {
    const options: PostingOptionView[] = values.boardId ? [boardOption(values.boardId, values.boardName || values.boardId)] : [];
    return { ...common, options, disabled: { reason: BOARDS_LOADING_REASON } };
  }
  if (details.boards.length === 0) {
    return { ...common, options: [], disabled: { reason: NO_BOARDS_REASON } };
  }
  const options: PostingOptionView[] = details.boards.map((b) => boardOption(b.id, b.name));
  if (values.boardId && !details.boards.some((b) => b.id === values.boardId)) {
    options.push({
      value: values.boardId,
      label: `${values.boardName || values.boardId} — no longer on Pinterest`,
      disabled: { reason: "This board is no longer on Pinterest." },
    });
  }
  return { ...common, options };
}

function textField(key: "title" | "link", label: string, value: string, maxLength: number): PostingFieldView {
  return { key, label, kind: "text", value, maxLength, countingRule: "code_points", optional: true };
}

/** Pure, total (G25). */
function view({ values, details }: { values: PinterestPostingValues | null; details: PinterestDetails | null }): PostingFieldView[] {
  const v = values ?? DEFAULT_POSTING_VALUES;
  return [
    boardField(v, details),
    textField("title", "Pin title", v.title, PINTEREST_TITLE_MAX),
    textField("link", "Pin link", v.link, PINTEREST_LINK_MAX),
  ];
}

function notice(): { text: string; doc?: string; docLabel?: string } {
  return { text: PINTEREST_TRIAL_TEXT, doc: SETUP, docLabel: "Read how Pinterest's Trial access works" };
}

/** K21, FR-018. */
function targetNote(values: PinterestPostingValues | null): string | null {
  if (!values || !values.boardId) return null;
  return values.boardName ? `Board: ${values.boardName}` : "Board chosen";
}

function summaryNotes(): string[] {
  return [PINTEREST_TRIAL_TEXT, "A pin needs one image and a board.", "About 100 pins a minute per account."];
}

export const AFTER_PREVIEW = "The pin's title and link are Pinterest-only; other accounts ignore them.";

export const pinterestPosting: PostingDeclaration<PinterestPostingValues, PinterestDetails> = {
  valuesSchema: pinterestPostingSchema,
  view,
  notice,
  targetNote,
  summaryNotes,
  afterPreview: AFTER_PREVIEW,
};
