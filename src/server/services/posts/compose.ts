import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { UPLOAD_MIME_TYPES } from "@/lib/media/types";
import { requirementsOf, type RequirementsSummary } from "@/providers/requirements";
import { findProvider } from "@/providers/registry";
import { countText, countingRuleName } from "@/providers/text";
import type { PostType, PostingFieldView, ValidationIssue } from "@/providers/types";
import { choiceFor, resolvePostType } from "@/providers/post-type";
import type { PostTypeOption } from "@/providers/types";
import { durationLabel, videoStepWords } from "@/providers/video-labels";
import { videoFieldsOf } from "../../media/item";
import { previewRequestFor, viewOf } from "../video-previews";
import { itemOf, planVideoFor } from "../media-variants";
import { postInputSchema } from "@/lib/validation/scheduling";
import * as clock from "../../dal/clock";
import { ForbiddenError, NotFoundError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";
import { nearQueuedWarnings, type Warning } from "../queue";
import { resolveLocalDateTime } from "../queue/occurrences";
import { assertPostTypeOffered, checkVideoEdits } from "./content";
import { fingerprintOf, parsedPostingValues } from "./consent";
import { targetNoteFor } from "./notes";
import { readAccountDetails } from "../account-details";
import { validateTargetContent, type TargetContent } from "./validate";

const STARTED = ["publishing", "published", "ambiguous"] as const;

/** `refreshDetails` bypasses the account-details cache; only the composer's Retry sends it. */
const checkSchema = postInputSchema.extend({ postId: z.uuid().optional(), refreshDetails: z.boolean().optional() });

/** The posting panel of one target (G25–G27). */
export interface PostingPanelView {
  heading: string | null;
  notice: { text: string; doc?: string } | null;
  details: "ready" | "error";
  detailsError: string | null;
  fields: PostingFieldView[];
  afterPreview: string | null;
  consent: { declaration: string; fingerprint: string; agreed: boolean } | null;
}

/** What Docket will do with one video for one target (contracts/video-composer.md "Check response"). */
export interface VideoTargetView {
  mediaId: string;
  /** Position in the post. */
  index: number;
  plan: "as_is" | "adapted" | "rewrap" | "refused" | "checking";
  /** Badge words, empty unless adapted or rewrapped. */
  steps: string[];
  /** The planner's sentences. */
  notes: string[];
  /** Refusal sentences. */
  reasons: string[];
  /** Planned output, e.g. "1:30" and "1080×1920". */
  output: { durationLabel: string; sizeLabel: string } | null;
  /** The original for a file that goes as stored; the worker's render for an adapted one; none when refused or still being read. */
  preview:
    | { kind: "original"; url: string; posterUrl: string | null }
    | { kind: "render"; key: string; state: "none" | "queued" | "building" | "ready" | "failed"; url: string | null; error: string | null }
    | null;
}

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
  /** One entry per video on the post, in post order; empty when there is none. */
  videos: VideoTargetView[];
  canSchedule: boolean;
  /** What the account accepts; `null` exactly when `limit` is `null` (provider not registered). Present with no text and no media. */
  requirements: RequirementsSummary | null;
  /** Null exactly when the provider declares no `posting`. */
  posting?: PostingPanelView | null;
  /** The provider's short label for this target, e.g. "Private on TikTok". */
  note?: string | null;
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

  const videoEdits = checkVideoEdits(assets, parsed.videoEdits);
  const stored = new Map<string, PostType | null>();
  const storedPosting = new Map<string, unknown>();
  let editable = true;
  let reviewBlocked = false;
  if (parsed.postId) {
    const post = await scope.posts.get(parsed.postId);
    if (!post) throw new NotFoundError();
    reviewBlocked = post.reviewState === "needs_review";
    const existing = await scope.targets.listForPost(post.id);
    for (const t of existing) {
      stored.set(t.socialAccountId, t.chosenPostType);
      storedPosting.set(t.socialAccountId, t.postingFields);
    }
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
    const caps = provider?.capabilities ?? null;
    const resolved = resolvePostType(caps, media, chosen);
    // G25–G27: values (input, else stored), live details (cached), and the fingerprint of the unsaved state.
    let panel: PostingPanelView | null = null;
    let values: unknown | null = null;
    let postingIssues: ValidationIssue[] | null = null;
    const content: TargetContent = { text: effectiveText, assets, referenced: assets.length, chosenPostType: chosen, videoEdits };
    if (provider?.posting) {
      values = parsedPostingValues(provider, target.posting !== undefined ? target.posting : (storedPosting.get(account.id) ?? null));
      let details: unknown | null = null;
      let detailsError: string | null = null;
      if (provider.accountDetails) {
        const read = await readAccountDetails(scope, account.id, parsed.refreshDetails ? { fresh: true } : {});
        if (read.ok) details = read.details;
        else detailsError = read.message;
      }
      content.postingFields = values;
      content.postingDetails = details;
      content.consent = target.consent?.fingerprint ? { fingerprint: target.consent.fingerprint, details } : null;
      const fingerprint = provider.consent && !detailsError ? fingerprintOf(provider, content, details) : "";
      panel = {
        heading: provider.posting.heading?.(details) ?? null,
        notice: provider.posting.notice?.() ?? null,
        details: detailsError ? "error" : "ready",
        detailsError,
        fields: provider.posting.view({ values, details, postType: resolved }),
        afterPreview: provider.posting.afterPreview ?? null,
        consent: provider.consent
          ? { declaration: provider.consent.declaration(values), fingerprint, agreed: !!fingerprint && target.consent?.fingerprint === fingerprint }
          : null,
      };
      if (detailsError) {
        postingIssues = [{ severity: "error", code: "details_unavailable", message: detailsError, field: "posting" }];
      }
    }
    let issues = (await validateTargetContent(scope, account, content, { preview: true })) ?? [];
    if (postingIssues) issues = [...issues.filter((i) => i.field !== "consent"), ...postingIssues];
    const choice = choiceFor(caps, media);
    const rule = provider?.capabilities.text.countingRule ?? null;
    const videos: VideoTargetView[] = [];
    if (provider) {
      for (const [index, asset] of assets.entries()) {
        if (asset.kind !== "video") continue;
        const plan = planVideoFor(asset, provider.capabilities, resolved, index, provider.displayName, videoEdits.get(asset.id));
        const original = { kind: "original" as const, url: asset.publicUrl, posterUrl: asset.thumbnailUrl ?? null };
        const base = { mediaId: asset.id, index, steps: [], notes: [], reasons: [], output: null };
        if (!plan) videos.push({ ...base, plan: "checking", preview: null });
        else if (plan.kind === "original") videos.push({ ...base, plan: "as_is", preview: original });
        else if (plan.kind === "checking") videos.push({ ...base, plan: "checking", notes: plan.notes.map((n) => n.message), preview: null });
        else if (plan.kind === "refuse") videos.push({ ...base, plan: "refused", reasons: plan.issues.map((n) => n.message), preview: null });
        else {
          const { output } = plan;
          const wanted = previewRequestFor(asset.id, plan, itemOf(asset).video?.frameRate ?? null);
          const [row] = wanted ? await scope.videoVersions.getPreviewsByKeys([wanted.key]) : [];
          const render = wanted ? { kind: "render" as const, ...(row ? viewOf(row) : { key: wanted.key, state: "none" as const, url: null, error: null }) } : null;
          videos.push({
            ...base,
            plan: plan.mode === "rewrap" ? "rewrap" : "adapted",
            steps: videoStepWords(plan),
            notes: plan.notes.map((n) => n.message),
            output: { durationLabel: durationLabel(output.durationSeconds), sizeLabel: `${output.width}×${output.height}` },
            preview: plan.mode === "rewrap" ? original : render,
          });
        }
      }
    }
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
      videos,
      canSchedule: !!provider && account.status === "active" && !issues.some((i) => i.severity === "error"),
      requirements: provider
        ? requirementsOf(provider.capabilities, {
            uploadTypes: UPLOAD_MIME_TYPES,
            postType: resolved,
            notes: provider.posting?.summaryNotes?.() ?? [],
          })
        : null,
      posting: panel,
      note: provider?.posting ? targetNoteFor(account.providerKey, values) : null,
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
