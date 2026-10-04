"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionResult } from "@/lib/action-result";
import { regeneratePost } from "@/server/services/generation/regenerate";
import { planSeries, startSeries, writeSeriesPost } from "@/server/services/generation/series";
import { generateSingle, type GenerateResult } from "@/server/services/generation/single";
import * as posts from "@/server/services/posts";
import { runAction } from "../run-action";

type VariantUpdate = Awaited<ReturnType<typeof posts.updatePostVariants>>;

/** A model failure is data (`ok: false` inside), so the form can show it with "Try again". */
export async function generateSingleAction(slug: string, input: unknown): Promise<ActionResult<GenerateResult>> {
  const result = await runAction(slug, (scope) => generateSingle(scope, input));
  if (result.ok && result.data.ok) refresh();
  return result;
}

export async function regenerateAction(
  slug: string,
  input: { postId: string; instruction?: string | null },
): Promise<ActionResult<GenerateResult>> {
  const result = await runAction(slug, (scope) =>
    regeneratePost(scope, input?.postId, { instruction: input?.instruction ?? null }),
  );
  if (result.ok && result.data.ok) refresh();
  return result;
}

export async function updatePostVariantsAction(
  slug: string,
  input: { postId: string; edits: { providerKey: string; text: string }[] },
): Promise<ActionResult<{ problems: VariantUpdate["problems"] }>> {
  const result = await runAction(slug, async (scope) => {
    const { problems } = await posts.updatePostVariants(scope, input?.postId, { edits: input?.edits });
    return { problems };
  });
  if (result.ok) refresh();
  return result;
}

/** Planning saves nothing; a model failure is data, like single mode. */
export async function planSeriesAction(slug: string, input: unknown): Promise<ActionResult<Awaited<ReturnType<typeof planSeries>>>> {
  return runAction(slug, (scope) => planSeries(scope, input));
}

export async function startSeriesAction(slug: string, input: unknown): Promise<ActionResult<{ seriesId: string }>> {
  const result = await runAction(slug, (scope) => startSeries(scope, input));
  if (result.ok) redirect(`/p/${slug}/generate/series/${result.data.seriesId}`);
  return result;
}

export async function writeSeriesPostAction(
  slug: string,
  input: { seriesId: string; position: number },
): Promise<ActionResult<GenerateResult & { position: number }>> {
  const result = await runAction(slug, (scope) => writeSeriesPost(scope, input?.seriesId, input?.position));
  if (result.ok && result.data.ok) refresh();
  return result;
}
