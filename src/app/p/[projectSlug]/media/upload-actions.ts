"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { getEnv } from "@/server/env";
import { libraryLimits, type LibraryLimits } from "@/server/media/limits";
import * as uploads from "@/server/services/uploads";
import { ForbiddenError } from "@/server/dal/errors";
import { runAction } from "../run-action";

/** The six JSON calls of one upload (contracts/uploads.md). Expected refusals come back as data, never thrown. */
export async function createUploadAction(slug: string, input: unknown): Promise<ActionResult<uploads.CreateUploadResult>> {
  return runAction(slug, (scope) => uploads.createUpload(scope, input));
}

export async function signUploadPartsAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<Awaited<ReturnType<typeof uploads.signUploadParts>>>> {
  return runAction(slug, (scope) => uploads.signUploadParts(scope, input));
}

export async function listUploadedPartsAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<Awaited<ReturnType<typeof uploads.listUploadedParts>>>> {
  return runAction(slug, (scope) => uploads.listUploadedParts(scope, input));
}

export async function completeUploadAction(slug: string, input: unknown): Promise<ActionResult<uploads.CompleteUploadResult>> {
  const result = await runAction(slug, (scope) => uploads.completeUpload(scope, input));
  if (result.ok && result.data.ok && result.data.asset.status === "ready") refresh();
  return result;
}

export async function cancelUploadAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<Awaited<ReturnType<typeof uploads.cancelUpload>>>> {
  return runAction(slug, (scope) => uploads.cancelUpload(scope, input));
}

export async function mediaProcessingStatusAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<Awaited<ReturnType<typeof uploads.processingStatus>>>> {
  return runAction(slug, (scope) => uploads.processingStatus(scope, input));
}

/** The limits the browser checks against and words its messages from (P13). */
export async function uploadLimitsAction(slug: string): Promise<ActionResult<LibraryLimits>> {
  return runAction(slug, async (scope) => {
    if (!scope.can({ media: ["view"] })) throw new ForbiddenError();
    return libraryLimits(getEnv());
  });
}
