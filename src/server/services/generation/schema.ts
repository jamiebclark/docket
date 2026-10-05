import { z } from "zod";
import type { MediaRow } from "../../dal/media";
import type { ProjectScope } from "../../dal/scope";
import { findProvider } from "../../../providers/registry";
import type { VariantGroup } from "../../../lib/generation/groups";
import { validateTargetContent } from "../posts/validate";

/** Wire + parse schema for one post. Required properties only: no lengths, counts or unions (research R4). */
export function generationOutputSchema(groupKeys: readonly string[], imageCount: number) {
  const variants = z.strictObject(
    Object.fromEntries(groupKeys.map((k) => [k, z.strictObject({ text: z.string() })])),
  );
  return z.strictObject({
    variants,
    ...(imageCount > 0 ? { imageAltTexts: z.array(z.string()) } : {}),
  }) as unknown as z.ZodType<{ variants: Record<string, { text: string }>; imageAltTexts?: string[] }>;
}

export const seriesPlanSchema = z.strictObject({
  angles: z.array(z.strictObject({ title: z.string(), description: z.string() })),
});
export type SeriesPlan = z.infer<typeof seriesPlanSchema>;

export const ANGLE_TITLE_MAX = 120;
export const ANGLE_DESCRIPTION_MAX = 300;

/** `groupKey` and `providerKey` are null for problems that are not about one variant. */
export interface OutputProblem {
  groupKey: string | null;
  providerKey: string | null;
  message: string;
  /** The retry-prompt prefix for a variant of a split platform: `bluesky_2 (Bluesky: Acme News)`. */
  label?: string;
}

export interface OutputCheck {
  /** Trigger a retry and, if still present after it, are shown on the result. */
  problems: OutputProblem[];
  /** Warnings and info never block and never retry. */
  warnings: OutputProblem[];
}

/** The line shown in the retry prompt and stored in the generation record. */
export const problemLine = (p: OutputProblem): string => {
  const head = p.label ?? p.groupKey;
  return head ? `${head}: ${p.message}` : p.message;
};

/** `bluesky_2 (Bluesky: Acme News)` when the key differs from its platform, else null. */
function groupLabel(g: VariantGroup): string | undefined {
  if (g.key === g.providerKey) return undefined;
  const platform = findProvider(g.providerKey)?.displayName ?? g.providerKey;
  return `${g.key} (${platform}: ${g.accounts.map((a) => a.displayName).join(", ")})`;
}

export async function checkGenerationOutput(
  scope: Pick<ProjectScope, "media">,
  input: {
    groups: readonly VariantGroup[];
    assets: readonly MediaRow[];
    output: { variants: Record<string, { text: string }>; imageAltTexts?: string[] };
  },
): Promise<OutputCheck> {
  const problems: OutputProblem[] = [];
  const warnings: OutputProblem[] = [];
  for (const group of input.groups) {
    const key = group.key;
    const where = { groupKey: key, providerKey: group.providerKey, label: groupLabel(group) };
    const text = input.output.variants[key]?.text ?? "";
    if (text.trim().length === 0) {
      problems.push({ ...where, message: "The post is empty." });
      continue;
    }
    const issues = await validateTargetContent(
      scope,
      { providerKey: group.providerKey },
      { text, assets: input.assets, referenced: input.assets.length },
      { preview: true },
    );
    for (const issue of issues ?? []) {
      if (issue.severity === "error") problems.push({ ...where, message: issue.message });
      else warnings.push({ ...where, message: issue.message });
    }
  }
  const n = input.assets.length;
  if (n > 0) {
    const alts = input.output.imageAltTexts ?? [];
    if (alts.length !== n) {
      problems.push({ groupKey: null, providerKey: null, message: `Write exactly ${n} alt texts, one per image.` });
    } else {
      const limits = [...new Set(input.groups.map((g) => g.providerKey))]
        .map((k) => findProvider(k)?.capabilities.media.maxAltTextLength)
        .filter((v): v is number => typeof v === "number");
      if (limits.length > 0) {
        const min = Math.min(...limits);
        alts.forEach((alt, i) => {
          if (alt.length > min) {
            problems.push({ groupKey: null, providerKey: null, message: `Alt text ${i + 1} is ${alt.length} characters; the limit is ${min}.` });
          }
        });
      }
    }
  }
  return { problems, warnings };
}

export function checkSeriesPlan(plan: SeriesPlan, count: number): OutputProblem[] {
  const problems: OutputProblem[] = [];
  const { angles } = plan;
  if (angles.length !== count) {
    problems.push({ groupKey: null, providerKey: null, message: `Expected ${count} angles, got ${angles.length}.` });
  }
  angles.forEach((a, i) => {
    const title = a.title.trim();
    const description = a.description.trim();
    if (title.length === 0 || title.length > ANGLE_TITLE_MAX) {
      problems.push({ groupKey: null, providerKey: null, message: `Angle ${i + 1}: the title must be 1 to ${ANGLE_TITLE_MAX} characters.` });
    }
    if (description.length === 0 || description.length > ANGLE_DESCRIPTION_MAX) {
      problems.push({
        groupKey: null,
        providerKey: null,
        message: `Angle ${i + 1}: the description must be 1 to ${ANGLE_DESCRIPTION_MAX} characters.`,
      });
    }
  });
  const fold = (s: string) => s.trim().toLowerCase();
  for (let i = 0; i < angles.length; i++) {
    for (let j = i + 1; j < angles.length; j++) {
      if (fold(angles[i]!.title) === fold(angles[j]!.title)) {
        problems.push({ groupKey: null, providerKey: null, message: `Angles ${i + 1} and ${j + 1} are the same.` });
      }
    }
  }
  return problems;
}
