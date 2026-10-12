// data-model.md §5, steps 2 to 6: the three-transaction send, shared by the tick and by every
// integration test (E9). Holds no transaction across `mailer.send()` (FR-024).
import { type Cadence, type ScheduleSettings, isStaleDigest, nextDue, resolveZone } from "../../../lib/email/schedule";
import { renderProblemEmail } from "../../../lib/email/render";

/**
 * The two RFC 8058 headers, or none at all (docs/research/smtp.md).
 *
 * `List-Unsubscribe` MUST carry an https URI, and `BETTER_AUTH_URL` is routinely http on a developer's
 * machine — so an http endpoint gets no headers rather than non-conformant ones. The unsubscribe link
 * in the message body is unaffected either way.
 */
export function unsubscribeHeaders(oneClickUrl: string): { headers?: Record<string, string> } {
  if (!oneClickUrl.startsWith("https://")) return {};
  return {
    headers: {
      "List-Unsubscribe": `<${oneClickUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
import {
  emailDb,
  markInFlight,
  recipientEmail,
  recordAttempt,
  releaseClaim,
  type ClaimedPerson,
  type EmailOutcomeClass,
  type RecordAttemptConfig,
} from "../../dal/email";
import type { Mailer, MailOutcome } from "../../mail/types";
import { assembleForPerson } from "./assemble";

export interface SendResult {
  outcome: EmailOutcomeClass | "skipped";
  problemCount: number;
  /** What the tick counts; `skipped` covers a stale digest, an empty assembly and a lost lease. */
  disposition: "sent" | "retry" | "paused" | "skipped" | "unavailable";
}

export type EmailSendConfig = RecordAttemptConfig;

function scheduleSettingsOf(claim: ClaimedPerson): ScheduleSettings {
  const row = claim.settings;
  return {
    cadence: row.cadence as Cadence,
    digestHour: row.digestHour,
    timeZone: resolveZone(row.timeZone, []),
    quietStartHour: row.quietStartHour,
    quietEndHour: row.quietEndHour,
  };
}

/** Shared with invitation delivery: one `MailOutcome` -> one `EmailOutcomeClass` plus its SMTP detail. */
export function classifyMailOutcome(outcome: MailOutcome): { outcome: EmailOutcomeClass; code: number | null; durationMs: number } {
  if (outcome.kind === "sent") return { outcome: "sent", code: outcome.code, durationMs: outcome.durationMs };
  if (outcome.kind === "rejected") return { outcome: "rejected", code: outcome.code, durationMs: outcome.durationMs };
  if (outcome.kind === "unavailable") return { outcome: "unavailable", code: null, durationMs: 0 };
  return { outcome: outcome.reason, code: outcome.code, durationMs: outcome.durationMs };
}

/** data-model.md §5, steps 2 to 6. Shared by the tick and by every integration test (E9). */
export async function sendForClaimedPerson(input: {
  claim: ClaimedPerson;
  mailer: Mailer;
  cfg: EmailSendConfig;
  now: Date;
}): Promise<SendResult> {
  const { claim, mailer, cfg, now } = input;
  const row = claim.settings;
  const zone = resolveZone(row.timeZone, []);
  const cadence = row.cadence as "immediate" | "digest";
  const settings = scheduleSettingsOf(claim);
  const db = emailDb();

  // Step 2: a digest claimed after its own local day has passed is skipped, not sent stale (N53).
  if (row.nextDueAt && isStaleDigest(settings, row.nextDueAt, now)) {
    await releaseClaim(db, row.userId, claim.token, nextDue(settings, row.lastSentAt, now));
    return { outcome: "skipped", problemCount: 0, disposition: "skipped" };
  }

  // Step 3: assemble, outside any transaction. Nothing eligible releases the lease and rolls the clock (N52).
  const assembled = await assembleForPerson({ userId: row.userId, cadence, zone, now });
  if (!assembled) {
    await releaseClaim(db, row.userId, claim.token, nextDue(settings, row.lastSentAt, now));
    return { outcome: "skipped", problemCount: 0, disposition: "skipped" };
  }

  // Step 4: mark in flight, lease verified. A lease lost between claim and here writes nothing.
  const marked = await markInFlight(db, claim, assembled.highWater);
  if (marked === "stale") {
    return { outcome: "skipped", problemCount: assembled.problemCount, disposition: "skipped" };
  }

  // Step 5: send. No transaction is held across this call (FR-024).
  const address = await recipientEmail(db, row.userId);
  const { subject, text, html } = renderProblemEmail(assembled.model);
  let outcome: MailOutcome;
  try {
    outcome = address
      ? await mailer.send({ to: address, subject, text, html, ...unsubscribeHeaders(assembled.oneClickUrl) })
      : { kind: "failed", reason: "internal", code: null, durationMs: 0 };
  } catch {
    // The interface promises never to throw (E4); a test mailer that does is treated as Docket's own fault.
    outcome = { kind: "failed", reason: "internal", code: null, durationMs: 0 };
  }

  // Step 6: record, lease verified, always an attempt row.
  const classified = classifyMailOutcome(outcome);
  const result = await recordAttempt(
    db,
    claim,
    { purpose: "problems", cadence, problemCount: assembled.problemCount, smtpCode: classified.code, durationMs: classified.durationMs },
    classified.outcome,
    cfg,
  );
  if (result === "stale") {
    return { outcome: "skipped", problemCount: assembled.problemCount, disposition: "skipped" };
  }
  return { outcome: result.outcome, problemCount: assembled.problemCount, disposition: result.disposition };
}
