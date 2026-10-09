import { createHash } from "node:crypto";
import { DEFAULT_VIDEO_EDIT } from "../../../lib/video/edit";
import type { SocialProvider, ValidationIssue } from "../../../providers/types";
import * as clock from "../../dal/clock";
import type { ProjectScope } from "../../dal/scope";
import type { TargetRecord } from "../../dal/targets";
import type { TargetContent } from "./validate";

export type ConsentStatus = { kind: "valid" } | { kind: "missing" } | { kind: "stale" };

/** Sorted keys, no whitespace, so equal values always hash alike. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function consentFingerprint(input: {
  text: string;
  mediaIds: readonly string[];
  videoEdits: ReadonlyArray<{ mediaId: string; edit: unknown }>;
  values: unknown | null;
  details: unknown | null;
}): string {
  const videoEdits = [...input.videoEdits].sort((a, b) => (a.mediaId < b.mediaId ? -1 : a.mediaId > b.mediaId ? 1 : 0));
  const body = canonicalJson({
    v: 1,
    text: input.text,
    mediaIds: input.mediaIds,
    videoEdits,
    values: input.values,
    details: input.details,
  });
  return `v1:${createHash("sha256").update(body).digest("hex")}`;
}

/** Parsed posting values, or null when never set or unreadable. */
export function parsedPostingValues(provider: SocialProvider, raw: unknown): unknown | null {
  if (!provider.posting || raw === null || raw === undefined) return null;
  const r = provider.posting.valuesSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Parsed account details; null when the provider has no reader or the value is unreadable. */
export function parsedDetails(provider: SocialProvider, raw: unknown): unknown | null {
  if (!provider.accountDetails || raw === null || raw === undefined) return null;
  const r = provider.accountDetails.schema.safeParse(raw);
  return r.success ? r.data : null;
}

/** The fingerprint of `content` as it stands, for the given details. */
export function fingerprintOf(provider: SocialProvider, content: TargetContent, details: unknown | null): string {
  return consentFingerprint({
    text: content.text,
    mediaIds: content.assets.map((a) => a.id),
    videoEdits: content.assets
      .filter((a) => a.kind === "video")
      .map((a) => ({ mediaId: a.id, edit: content.videoEdits?.get(a.id) ?? DEFAULT_VIDEO_EDIT })),
    values: parsedPostingValues(provider, content.postingFields),
    details,
  });
}

/** Compares the stored consent with the content, using the details stored with it. */
export function consentStatus(provider: SocialProvider, content: TargetContent): ConsentStatus {
  const stored = content.consent;
  if (!stored) return { kind: "missing" };
  const fingerprint = fingerprintOf(provider, content, parsedDetails(provider, stored.details));
  return fingerprint === stored.fingerprint ? { kind: "valid" } : { kind: "stale" };
}

export function consentIssue(provider: SocialProvider): ValidationIssue {
  return {
    severity: "error",
    code: "consent_required",
    field: "consent",
    message: `Tick 'I agree' to post to ${provider.displayName}.`,
  };
}

/** The gate's consent issue, or null when the provider needs none or it is valid. A target without posting values leaves the provider's own issue standing alone. */
export function consentIssueFor(provider: SocialProvider, content: TargetContent): ValidationIssue | null {
  if (!provider.consent || !provider.posting) return null;
  if (parsedPostingValues(provider, content.postingFields) === null) return null;
  return consentStatus(provider, content).kind === "valid" ? null : consentIssue(provider);
}

/** The engine's refusal text for a target whose consent is not valid, or null (G27). */
export function engineConsentRefusal(provider: SocialProvider, content: TargetContent): string | null {
  if (!provider.consent) return null;
  if (consentStatus(provider, content).kind === "valid") return null;
  return `No consent recorded for this ${provider.displayName} post; nothing was posted.`;
}

type Tx = Pick<ProjectScope, "targets" | "actor" | "membership">;

/**
 * Records or clears the consent after a save. `content` is the target's content as just saved; `details` the live
 * account details read before the transaction (null when unreadable). Returns whether consent is now valid.
 */
export async function recordConsentOnSave(
  tx: Tx,
  target: TargetRecord,
  provider: SocialProvider,
  content: TargetContent,
  input: { consent?: { fingerprint: string } | null | undefined },
  details: unknown | null,
): Promise<boolean> {
  if (!provider.consent) return false;
  const stored = content.consent;
  const sent = input.consent?.fingerprint;
  if (sent && tx.actor.kind === "member" && (details !== null || !provider.accountDetails)) {
    const fingerprint = fingerprintOf(provider, content, details);
    if (sent === fingerprint) {
      await tx.targets.update(target.id, {
        consentByUserId: tx.membership.userId,
        consentAt: await clock.now(),
        consentFingerprint: fingerprint,
        consentDetails: details,
      });
      return true;
    }
  }
  if (!stored) return false;
  // Judged on the details stored with the consent, so a failed live read never clears a good record.
  if (consentStatus(provider, content).kind === "valid") return true;
  await tx.targets.update(target.id, { consentByUserId: null, consentAt: null, consentFingerprint: null, consentDetails: null });
  return false;
}
