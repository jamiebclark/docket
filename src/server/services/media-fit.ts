import { mediaConstraintsOf, type ImageStep } from "../../providers/media";
import { MIME_LABEL } from "../../lib/media/types";
import { findProvider } from "../../providers/registry";
import type { SocialProvider } from "../../providers/types";
import { validateAgainstCapabilities } from "../../providers/validation";
import type { MediaRow } from "../dal/media";
import type { ProjectScope } from "../dal/scope";
import { planFor, plannedItem } from "./media-variants";

export type FitState = "fits" | "converted" | "refused";

export interface PlatformFit {
  providerKey: string;
  providerName: string;
  state: FitState;
  /** Empty unless `state` is "converted". */
  steps: ImageStep[];
  /** The planner's own sentences, written with the label "This image". Empty when the image fits. */
  details: string[];
  /** The output type label (e.g. "JPEG") when `steps` include "convert". */
  convertedTo: string | null;
}

const LABEL = "This image";
/** Alt text is the person's to write, not a property of the image. */
const ALT_CODES = new Set(["missing_alt_text", "alt_text_too_long"]);

/** Pure: the planner's own decision for one image and one provider, so a badge can never disagree with publishing. */
export function fitOf(asset: MediaRow, provider: SocialProvider): PlatformFit {
  const base = { providerKey: provider.key, providerName: provider.displayName };
  const plan = planFor(asset, mediaConstraintsOf(provider.capabilities), 0, provider.displayName, LABEL);
  if (plan.kind === "refuse") {
    return { ...base, state: "refused", steps: [], details: plan.issues.map((i) => i.message), convertedTo: null };
  }
  const errors = validateAgainstCapabilities(
    { text: "x", media: [plannedItem(asset, plan)] },
    provider.capabilities,
  )
    .filter((i) => i.severity === "error" && i.field?.startsWith("media") && !ALT_CODES.has(i.code))
    .map((i) => i.message.replace(/^Image 1\b/, LABEL));
  if (errors.length > 0) return { ...base, state: "refused", steps: [], details: errors, convertedTo: null };
  if (plan.kind === "original") return { ...base, state: "fits", steps: [], details: [], convertedTo: null };
  return {
    ...base,
    state: "converted",
    steps: plan.steps,
    details: plan.notes.map((n) => n.message),
    convertedTo: plan.steps.includes("convert") ? (MIME_LABEL[plan.output.mimeType] ?? plan.output.mimeType) : null,
  };
}

export type FitSelection = { accountIds: string[] } | { active: true };

/** The providers to badge, deduplicated by key and sorted by name. Unknown and foreign ids are ignored silently. */
export async function fitPlatforms(
  scope: Pick<ProjectScope, "accounts">,
  sel: FitSelection,
): Promise<SocialProvider[]> {
  const accounts =
    "accountIds" in sel
      ? (await Promise.all([...new Set(sel.accountIds)].map((id) => scope.accounts.get(id)))).filter((a) => a !== null)
      : (await scope.accounts.list()).filter((a) => a.status === "active");
  const byKey = new Map<string, SocialProvider>();
  for (const a of accounts) {
    const p = findProvider(a.providerKey);
    if (p) byKey.set(p.key, p);
  }
  return [...byKey.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

