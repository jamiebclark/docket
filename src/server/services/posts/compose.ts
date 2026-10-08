import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { UPLOAD_MIME_TYPES } from "@/lib/media/types";
import { requirementsOf, type RequirementsSummary } from "@/providers/requirements";
import { findProvider } from "@/providers/registry";
import { countText, countingRuleName } from "@/providers/text";
import type { PostType, ValidationIssue } from "@/providers/types";
import { choiceFor, resolvePostType } from "@/providers/post-type";
import type { PostTypeOption } from "@/providers/types";
import { videoFieldsOf } from "../../media/item";
import { postInputSchema } from "@/lib/validation/scheduling";
import * as clock from "../../dal/clock";
import { ForbiddenError, NotFoundError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";
import { nearQueuedWarnings, type Warning } from "../queue";
import { resolveLocalDateTime } from "../queue/occurrences";
import { assertPostTypeOffered } from "./content";
import { validateTargetContent } from "./validate";

const STARTED = ["publishing", "published", "ambiguous"] as const;

const checkSchema = postInputSchema.extend({ postId: z.uuid().optional() });

export interface TargetCheck {
  accountId: string;
  displayName: string;
  providerName: string;
  effectiveText: string;
  count: number;
  limit: number | null;
  countingRule: string | null;
  /** The resolved post type for this content and choice. */
  postType: PostType | null;
  /** Present exactly when the provider offers a choice for this content (one video on Instagram). */
  postTypeChoice: { options: PostTypeOption[]; selected: PostType; default: PostType } | null;
  issues: ValidationIssue[];
  canSchedule: boolean;
  /** What the account accepts; `null` exactly when `limit` is `null` (provider not registered). Present with no text and no media. */
  requirements: RequirementsSummary | null;
}

export interface CompositionCheck {
  targets: TargetCheck[];
  /** No target of the saved post has started publishing. */
  editable: boolean;
  /** The saved post is waiting for review. */
  reviewBlocked: boolean;
}

/**
 * Per-target counts and issues for composer state that may not be saved (FR-002–FR-005). Same validation
 * path as scheduling, so the numbers here are the numbers `addToQueue` enforces. Writes nothing.
 */
export async function checkComposition(scope: ProjectScope, input: unknown): Promise<CompositionCheck> {
  const parsed = checkSchema.parse(input);
  if (!scope.can({ post: ["view"] })) throw new ForbiddenError();

  const ids = [...new Set(parsed.mediaIds)];
  const rows = new Map((await scope.media.getMany(ids)).map((r) => [r.id, r]));
  if (rows.size !== ids.length) throw new NotFoundError();
  const assets = parsed.mediaIds.map((id) => rows.get(id)!);

  const stored = new Map<string, PostType | null>();
  let editable = true;
  let reviewBlocked = false;
  if (parsed.postId) {
    const post = await scope.posts.get(parsed.postId);
    if (!post) throw new NotFoundError();
    reviewBlocked = post.reviewState === "needs_review";
    const existing = await scope.targets.listForPost(post.id);
    for (const t of existing) stored.set(t.socialAccountId, t.chosenPostType);
    editable = !existing.some((t) => (STARTED as readonly string[]).includes(t.status));
  }

  const targets: TargetCheck[] = [];
  for (const [i, target] of parsed.targets.entries()) {
    const account = await scope.accounts.get(target.accountId);
    if (!account) throw new NotFoundError();
    if (target.postType != null) assertPostTypeOffered(account.providerKey, target.postType, ["targets", i, "postType"]);
    // Absent = the stored value (when the post is saved), null = cleared.
    const chosen = target.postType !== undefined ? target.postType : (stored.get(account.id) ?? null);
    const provider = findProvider(account.providerKey);
    const effectiveText = target.overrideText ? target.overrideText : parsed.baseText;
    const media = assets.map((a) => ({ url: a.publicUrl, mimeType: a.mimeType, width: a.width, height: a.height, bytes: a.byteSize, altText: a.altText, ...videoFieldsOf(a) }));
    const issues =
      (await validateTargetContent(scope, account, { text: effectiveText, assets, referenced: assets.length, chosenPostType: chosen }, { preview: true })) ?? [];
    const caps = provider?.capabilities ?? null;
    const resolved = resolvePostType(caps, media, chosen);
    const choice = choiceFor(caps, media);
    const rule = provider?.capabilities.text.countingRule ?? null;
    targets.push({
      accountId: account.id,
      displayName: account.displayName,
      providerName: provider?.displayName ?? account.providerKey,
      effectiveText,
      count: rule ? countText(effectiveText, rule) : 0,
      limit: provider?.capabilities.text.maxLength ?? null,
      countingRule: rule ? countingRuleName(rule) : null,
      postType: provider ? resolved : null,
      postTypeChoice: choice ? { options: [...choice.options], selected: resolved, default: choice.default } : null,
      issues,
      canSchedule: !!provider && account.status === "active" && !issues.some((i) => i.severity === "error"),
      requirements: provider ? requirementsOf(provider.capabilities, { uploadTypes: UPLOAD_MIME_TYPES, postType: resolved }) : null,
    });
  }
  return { targets, editable, reviewBlocked };
}

const explicitSchema = z.object({
  /** Wall-clock `YYYY-MM-DDTHH:MM` in the project's zone. */
  local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  accountIds: z.array(z.uuid()).max(50).default([]),
  postId: z.uuid().optional(),
});

export interface ExplicitTimePreview {
  /** `gap`: the typed time does not exist that day; `overlap`: it happens twice and the earlier is used. */
  kind: "exact" | "gap" | "overlap";
  instant: string;
  /** The wall-clock time the post will actually go out, in the project zone. */
  resolvedLocal: string;
  inPast: boolean;
  warnings: Warning[];
}

/** What a typed local time becomes in the project zone, and whether it is in the past or near a queued post. Writes nothing; warnings never block. */
export async function previewExplicitTime(scope: ProjectScope, input: unknown): Promise<ExplicitTimePreview> {
  const parsed = explicitSchema.parse(input);
  if (!scope.can({ post: ["view"] })) throw new ForbiddenError();
  const zone = scope.project.timezone;
  let typed: Temporal.PlainDateTime;
  try {
    typed = Temporal.PlainDateTime.from(parsed.local);
  } catch {
    throw new z.ZodError([{ code: "custom", path: ["local"], message: "Enter a valid date and time." }]);
  }
  const instant = resolveLocalDateTime(zone, parsed.local);
  const zoned = instant.toZonedDateTimeISO(zone);
  const plain = zoned.toPlainDateTime();
  let kind: ExplicitTimePreview["kind"] = "exact";
  if (!plain.equals(typed)) kind = "gap";
  else if (typed.toZonedDateTime(zone, { disambiguation: "later" }).epochMilliseconds !== instant.epochMilliseconds) kind = "overlap";

  const when = new Date(instant.epochMilliseconds);
  const warnings: Warning[] = [];
  for (const accountId of new Set(parsed.accountIds)) {
    warnings.push(...(await nearQueuedWarnings(scope, accountId, when)));
  }
  return {
    kind,
    instant: when.toISOString(),
    resolvedLocal: plain.toString({ smallestUnit: "minute" }),
    inPast: when.getTime() <= (await clock.now()).getTime(),
    warnings,
  };
}
