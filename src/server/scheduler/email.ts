// scheduler/email: the outgoing-email section of a tick (contracts/services.md §6). Mirrors
// `runWebhookDeliveries()` line for line, with the capability check first (E18, SC-006).
import * as clock from "../dal/clock";
import { writeHeartbeat } from "../dal/heartbeats";
import { claimDuePeople, emailDb, purgeEmailHistory, recoverEmailClaims, releaseClaim, type ClaimedPerson } from "../dal/email";
import { getMailer } from "../mail";
import { sendForClaimedPerson } from "../services/email/send";
import { emailConfig, type SchedulerConfig } from "./config";

export interface EmailCounts {
  recovered: number; // leases reclaimed, each treated as sent (E10)
  claimed: number;
  sent: number;
  retried: number;
  paused: number;
  skipped: number; // stale digests, empty assemblies, deadline-released claims
  unavailable: number;
  purged: number;
}

export const emptyEmailCounts = (): EmailCounts => ({
  recovered: 0,
  claimed: 0,
  sent: 0,
  retried: 0,
  paused: 0,
  skipped: 0,
  unavailable: 0,
  purged: 0,
});

export async function runEmailDeliveries(opts: { config: SchedulerConfig; tickId: string; startedAt: Date }): Promise<EmailCounts> {
  const counts = emptyEmailCounts();
  const mailer = getMailer();
  if (!mailer) return counts; // no SMTP group configured: offer nothing, attempt nothing (E18, SC-006)

  const cfg = emailConfig(opts.config);
  const db = emailDb();
  const deadline = opts.startedAt.getTime() + cfg.timeBudgetMs;

  counts.recovered = await recoverEmailClaims(db);
  const claimed = await claimDuePeople(db, {
    limit: cfg.maxPerTick,
    leaseSeconds: Math.ceil(cfg.leaseMs / 1000),
    now: await clock.now(),
  });
  counts.claimed = claimed.length;

  const one = async (claim: ClaimedPerson) => {
    const at = await clock.now();
    if (deadline - at.getTime() < cfg.minWindowMs) {
      await releaseClaim(db, claim.settings.userId, claim.token, claim.settings.nextDueAt);
      counts.skipped++;
      return;
    }
    const result = await sendForClaimedPerson({ claim, mailer, cfg, now: at });
    if (result.disposition === "sent") counts.sent++;
    else if (result.disposition === "retry") counts.retried++;
    else if (result.disposition === "paused") counts.paused++;
    else if (result.disposition === "unavailable") counts.unavailable++;
    else counts.skipped++;
  };

  const queue = [...claimed];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try {
        await one(c);
      } catch (error) {
        console.error("Docket scheduler: email delivery errored:", error instanceof Error ? error.message : "unknown error");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency, queue.length) }, worker));

  counts.purged = await purgeEmailHistory(db, cfg.retentionDays);
  await writeHeartbeat("email", await clock.now(), { ...counts });
  return counts;
}
