import type { BadgeTone } from "../ui/Badge";
import type { FitState, PlatformFit } from "@/server/services/media-fit";

const WORDING: Record<FitState, string> = {
  fits: "fits",
  converted: "will be converted",
  adapted: "will be adapted",
  checking: "checking",
  refused: "will be refused",
};
const TONE: Record<FitState, BadgeTone> = { fits: "success", converted: "info", adapted: "info", checking: "neutral", refused: "danger" };

export const fitText = (f: Pick<PlatformFit, "providerName" | "state"> & { steps?: readonly string[] }): string =>
  f.state === "adapted" && f.steps && f.steps.length > 0
    ? `${f.providerName}: ${WORDING.adapted} (${f.steps.join(", ")})`
    : `${f.providerName}: ${WORDING[f.state]}`;
export const fitTone = (state: FitState): BadgeTone => TONE[state];

/** One line per non-fitting platform: the planner's own sentences, in order. Empty for "fits". */
export const fitNote = (f: Pick<PlatformFit, "providerName" | "state" | "details">): string | null =>
  f.state === "fits" || f.details.length === 0 ? null : `${f.providerName}: ${f.details.join(" ")}`;
