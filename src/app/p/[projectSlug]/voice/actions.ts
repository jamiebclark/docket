"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import * as voice from "@/server/services/voice";
import { runAction } from "../run-action";

const base = (slug: string) => `/p/${slug}/voice`;

export async function createVoiceAction(slug: string, input: unknown): Promise<ActionResult<{ profileId: string }>> {
  const result = await runAction(slug, async (scope) => {
    const { profileId } = await voice.createVoiceProfile(scope, input);
    return { profileId };
  });
  if (result.ok) revalidatePath(base(slug));
  return result;
}

export async function saveVoiceAction(
  slug: string,
  input: { profileId: string; name: string; content: unknown; baseVersion: number },
): Promise<ActionResult<{ version: number }>> {
  const result = await runAction(slug, (scope) =>
    voice.saveVoiceProfile(scope, input?.profileId, {
      name: input?.name,
      content: input?.content,
      baseVersion: input?.baseVersion,
    }),
  );
  if (result.ok) revalidatePath(base(slug), "layout");
  return result;
}

export async function setDefaultVoiceAction(slug: string, input: { profileId: string }): Promise<ActionResult<null>> {
  const result = await runAction(slug, async (scope) => {
    await voice.setDefaultVoiceProfile(scope, input?.profileId);
    return null;
  });
  if (result.ok) revalidatePath(base(slug), "layout");
  return result;
}

export async function archiveVoiceAction(slug: string, input: { profileId: string }): Promise<ActionResult<null>> {
  const result = await runAction(slug, async (scope) => {
    await voice.archiveVoiceProfile(scope, input?.profileId);
    return null;
  });
  if (result.ok) revalidatePath(base(slug), "layout");
  return result;
}

export async function restoreVoiceAction(slug: string, input: { profileId: string }): Promise<ActionResult<null>> {
  const result = await runAction(slug, async (scope) => {
    await voice.restoreVoiceProfile(scope, input?.profileId);
    return null;
  });
  if (result.ok) revalidatePath(base(slug), "layout");
  return result;
}

/** Nothing is saved, so nothing is revalidated. */
export async function tryVoiceAction(slug: string, input: unknown): Promise<ActionResult<voice.TryItResult>> {
  return runAction(slug, (scope) => voice.tryVoice(scope, input));
}
