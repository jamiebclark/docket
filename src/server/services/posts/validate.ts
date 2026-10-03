import { findProvider } from "../../../providers/registry";
import type { ValidationIssue } from "../../../providers/types";
import type { AccountRecord } from "../../dal/accounts";
import type { MediaRow } from "../../dal/media";
import type { ProjectScope } from "../../dal/scope";
import type { TargetRecord } from "../../dal/targets";
import { adaptedMediaFor } from "../media-variants";

export interface TargetContent {
  text: string;
  /** Live assets in post order. */
  assets: readonly MediaRow[];
  /** How many images the post references; more than `assets` means some were deleted. */
  referenced: number;
}

type Tx = Pick<ProjectScope, "targets" | "posts" | "media">;

/** Effective text of the target plus the live assets of its post. `null` when the target's post is gone. */
export async function loadTargetContent(tx: Tx, target: TargetRecord): Promise<TargetContent | null> {
  const content = await tx.targets.effectiveContent(target.id);
  if (!content) return null;
  const ids = await tx.posts.listMediaIds(target.postId);
  const rows = new Map((await tx.media.getMany(ids)).map((r) => [r.id, r]));
  const assets = ids.map((id) => rows.get(id)).filter((r): r is MediaRow => !!r);
  return { text: content.text, assets, referenced: ids.length };
}

const FIELD_RANK = (field: string): number =>
  field === "text" ? 0 : field === "postType" ? 1 : field === "media" ? 2 : 3 + Number(field.split(".")[1] ?? 0);

/**
 * The one validation path (FR-006–FR-017): adapted media → provider validation → the planner's notes and
 * refusals, merged in a stable order (text, postType, media, media.0, media.1 …). `null` when the provider
 * is not registered.
 */
export async function validateTargetContent(
  tx: Pick<ProjectScope, "media">,
  account: AccountRecord,
  content: TargetContent,
  opts: { preview?: boolean } = {},
): Promise<ValidationIssue[] | null> {
  const provider = findProvider(account.providerKey);
  if (!provider) return null;
  const { media, issues: planIssues } = await adaptedMediaFor(tx, provider.capabilities, provider.displayName, content.assets, opts);
  // An image the planner already refused (or could not adapt) would only repeat itself as a provider error.
  const planned = new Set(planIssues.filter((i) => i.severity === "error").map((i) => i.field));
  const providerIssues = provider
    .validate({ text: content.text, media }, provider.capabilities)
    .filter((i) => !planned.has(i.field));
  const unavailable: ValidationIssue[] =
    content.referenced > content.assets.length
      ? [{ severity: "error", code: "media_unavailable", message: "An image on this post has been deleted.", field: "media" }]
      : [];
  const merged = [...providerIssues, ...unavailable, ...planIssues];
  return merged
    .map((issue, i) => ({ issue, i }))
    .sort((a, b) => FIELD_RANK(a.issue.field) - FIELD_RANK(b.issue.field) || a.i - b.i)
    .map((x) => x.issue);
}
