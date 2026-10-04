import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { findProvider } from "@/providers/registry";
import { countText } from "@/providers/text";
import type { PostType, TextCountingRule, ValidationIssue } from "@/providers/types";
import { inferPostType } from "@/providers/validation";
import { postInputSchema } from "@/lib/validation/scheduling";
import * as clock from "../../dal/clock";
import { ForbiddenError, NotFoundError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";
import { nearQueuedWarnings, type Warning } from "../queue";
import { resolveLocalDateTime } from "../queue/occurrences";
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
  countingRule: TextCountingRule | null;
  postType: PostType | null;
  issues: ValidationIssue[];
  canSchedule: boolean;
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

  let editable = true;
  let reviewBlocked = false;
  if (parsed.postId) {
    const post = await scope.posts.get(parsed.postId);
    if (!post) throw new NotFoundError();
    reviewBlocked = post.reviewState === "needs_review";
    editable = !(await scope.targets.listForPost(post.id)).some((t) => (STARTED as readonly string[]).includes(t.status));
  }

  const targets: TargetCheck[] = [];
  for (const target of parsed.targets) {
    const account = await scope.accounts.get(target.accountId);
    if (!account) throw new NotFoundError();
    const provider = findProvider(account.providerKey);
    const effectiveText = target.overrideText ? target.overrideText : parsed.baseText;
    const media = assets.map((a) => ({ url: a.publicUrl, mimeType: a.mimeType, width: a.width, height: a.height, bytes: a.byteSize, altText: a.altText }));
    const issues =
      (await validateTargetContent(scope, account, { text: effectiveText, assets, referenced: assets.length }, { preview: true })) ?? [];
    const rule = provider?.capabilities.text.countingRule ?? null;
    targets.push({
      accountId: account.id,
      displayName: account.displayName,
      providerName: provider?.displayName ?? account.providerKey,
      effectiveText,
      count: rule ? countText(effectiveText, rule) : 0,
      limit: provider?.capabilities.text.maxLength ?? null,
      countingRule: rule,
      postType: provider ? inferPostType({ text: effectiveText, media }) : null,
      issues,
      canSchedule: !!provider && account.status === "active" && !issues.some((i) => i.severity === "error"),
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
