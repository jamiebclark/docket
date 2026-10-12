// The email DAL: settings (the person's own), the unsubscribe writes, and the tick's claim/send/record
// protocol (data-model.md §5, §6.3). Every cross-project read or write runs inside
// `runCrossProject("scheduler: …")`, the same escape hatch webhook delivery and housekeeping use (FR-043).
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { compileEligibility, preferencesOf, type EligibilityPlan, type PreferenceRow, type SwitchAxis } from "../../lib/notifications/eligibility";
import { type Cadence, type ScheduleSettings, nextDue, resolveZone } from "../../lib/email/schedule";
import { type Database, getDb } from "../db/client";
import { runCrossProject } from "../db/cross-project";
import {
  emailDeliveryAttempts,
  emailProjectState,
  emailSettings,
  member,
  notificationPreferences,
  notificationStates,
  projects,
  user,
  type EmailAttemptRow,
  type EmailSettingsRow,
} from "../db/schema";
import { now } from "./clock";

/** The pool the scheduler's cross-project email operations run on. */
export const emailDb = (): Database => getDb();

export type EmailOutcomeClass = "sent" | "unavailable" | "refused" | "rejected" | "timed_out" | "connect_failed" | "tls_failed" | "internal";

function scheduleSettingsOf(row: Pick<EmailSettingsRow, "cadence" | "digestHour" | "timeZone" | "quietStartHour" | "quietEndHour">): ScheduleSettings {
  return {
    cadence: row.cadence as Cadence,
    digestHour: row.digestHour,
    timeZone: resolveZone(row.timeZone, []),
    quietStartHour: row.quietStartHour,
    quietEndHour: row.quietEndHour,
  };
}

// ---- Settings, read and written by the person's own session (one user id, no project) ----

export async function readSettings(db: Database, userId: string): Promise<EmailSettingsRow | null> {
  const rows = await db.select().from(emailSettings).where(eq(emailSettings.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export interface EmailSettingsPatch {
  cadence: Cadence;
  digestHour: number;
  timeZone: string;
  quietStartHour: number | null;
  quietEndHour: number | null;
}

/** Recomputes `next_due_at` in the same transaction (FR-020). */
export async function upsertSettings(db: Database, userId: string, patch: EmailSettingsPatch): Promise<EmailSettingsRow> {
  return db.transaction(async (tx) => {
    const at = await now(tx);
    const existing = await tx.select().from(emailSettings).where(eq(emailSettings.userId, userId)).limit(1);
    const prev = existing[0] ?? null;
    const nextDueAt = patch.cadence === "off" ? null : nextDue(patch, prev?.lastSentAt ?? null, at);
    const patchValues = {
      cadence: patch.cadence,
      digestHour: patch.digestHour,
      timeZone: patch.timeZone,
      quietStartHour: patch.quietStartHour,
      quietEndHour: patch.quietEndHour,
      nextDueAt,
    };
    const [row] = await tx
      .insert(emailSettings)
      .values({ userId, ...patchValues })
      .onConflictDoUpdate({ target: emailSettings.userId, set: patchValues })
      .returning();
    return row!;
  });
}

/** Clears the pause and the failure count, rolls `next_due_at` forward (FR-023, N61). */
export async function resumeEmail(db: Database, userId: string): Promise<EmailSettingsRow | null> {
  return db.transaction(async (tx) => {
    const at = await now(tx);
    const rows = await tx.select().from(emailSettings).where(eq(emailSettings.userId, userId)).limit(1);
    const row = rows[0];
    if (!row) return null;
    const nextDueAt = row.cadence === "off" ? null : nextDue(scheduleSettingsOf(row), row.lastSentAt, at);
    const [updated] = await tx
      .update(emailSettings)
      .set({ pausedAt: null, pausedReason: null, consecutiveFailures: 0, nextDueAt })
      .where(eq(emailSettings.userId, userId))
      .returning();
    return updated ?? null;
  });
}

/** The person's own attempt history, newest first (FR-035). */
export async function lastAttempts(db: Database, userId: string, limit: number): Promise<EmailAttemptRow[]> {
  return db.select().from(emailDeliveryAttempts).where(eq(emailDeliveryAttempts.userId, userId)).orderBy(desc(emailDeliveryAttempts.at)).limit(limit);
}

/** The one address a send needs, read fresh each time rather than carried in the claim (FR-034, E34). */
export async function recipientEmail(db: Database, userId: string): Promise<string | null> {
  const rows = await db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
  return rows[0]?.email ?? null;
}

// ---- The unsubscribe writes, by user id out of the decrypted token (never from input) ----

/** `"no_person"` when the person has no settings row at all (deleted, or never turned email on). */
export async function setCadence(db: Database, userId: string, cadence: Cadence, hour?: number): Promise<"changed" | "unchanged" | "no_person"> {
  return runCrossProject("scheduler: unsubscribe set cadence", async () => {
    const at = await now(db);
    return db.transaction(async (tx) => {
      const rows = await tx.select().from(emailSettings).where(eq(emailSettings.userId, userId)).limit(1);
      const row = rows[0];
      if (!row) return "no_person";
      const digestHour = hour ?? row.digestHour;
      if (row.cadence === cadence && digestHour === row.digestHour) return "unchanged";
      const nextDueAt = cadence === "off" ? null : nextDue({ ...scheduleSettingsOf(row), cadence, digestHour }, row.lastSentAt, at);
      await tx.update(emailSettings).set({ cadence, digestHour, nextDueAt }).where(eq(emailSettings.userId, userId));
      return "changed";
    });
  });
}

/** Resolves the person's **current** memberships first, so a left project gives `"not_member"` (FR-029). */
export async function excludeProject(db: Database, userId: string, projectId: string): Promise<"changed" | "unchanged" | "not_member"> {
  return runCrossProject("scheduler: unsubscribe exclude project", async () => {
    return db.transaction(async (tx) => {
      const memberRows = await tx
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.userId, userId), eq(member.organizationId, projectId)))
        .limit(1);
      if (memberRows.length === 0) return "not_member";
      const existing = await tx
        .select({ excluded: emailProjectState.excluded })
        .from(emailProjectState)
        .where(and(eq(emailProjectState.projectId, projectId), eq(emailProjectState.userId, userId)))
        .limit(1);
      if (existing[0]?.excluded) return "unchanged";
      await tx
        .insert(emailProjectState)
        .values({ projectId, userId, excluded: true })
        .onConflictDoUpdate({
          target: [emailProjectState.projectId, emailProjectState.userId],
          set: { excluded: true, updatedAt: sql`now()` },
        });
      return "changed";
    });
  });
}

/** Resolves the person's **current** memberships first, so a left project gives `"not_member"` (FR-044). */
export async function includeProject(db: Database, userId: string, projectId: string): Promise<"changed" | "unchanged" | "not_member"> {
  return runCrossProject("scheduler: unsubscribe include project", async () => {
    return db.transaction(async (tx) => {
      const memberRows = await tx
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.userId, userId), eq(member.organizationId, projectId)))
        .limit(1);
      if (memberRows.length === 0) return "not_member";
      const existing = await tx
        .select({ excluded: emailProjectState.excluded })
        .from(emailProjectState)
        .where(and(eq(emailProjectState.projectId, projectId), eq(emailProjectState.userId, userId)))
        .limit(1);
      if (!existing[0]?.excluded) return "unchanged";
      await tx
        .update(emailProjectState)
        .set({ excluded: false, updatedAt: sql`now()` })
        .where(and(eq(emailProjectState.projectId, projectId), eq(emailProjectState.userId, userId)));
      return "changed";
    });
  });
}

// ---- The tick ----

export interface ClaimedPerson {
  settings: EmailSettingsRow;
  token: string;
}

/** Leases that expired before being recorded are recovered as sent (N54, E10): nothing is ever retried twice. */
export async function recoverEmailClaims(db: Database): Promise<number> {
  return runCrossProject("scheduler: recover email claims", async () => {
    const at = await now(db);
    return db.transaction(async (tx) => {
      const s = emailSettings;
      const stale = await tx
        .select()
        .from(s)
        .where(and(isNotNull(s.leaseUntil), lte(s.leaseUntil, at)))
        .for("update", { skipLocked: true });
      for (const row of stale) {
        await tx
          .update(emailProjectState)
          .set({ mailedSeq: sql`GREATEST(${emailProjectState.mailedSeq}, ${emailProjectState.sendingSeq})`, sendingSeq: null, updatedAt: at })
          .where(and(eq(emailProjectState.userId, row.userId), isNotNull(emailProjectState.sendingSeq)));
        await tx.insert(emailDeliveryAttempts).values({
          userId: row.userId,
          at,
          purpose: "problems",
          cadence: row.cadence === "digest" ? "digest" : "immediate",
          problemCount: 0,
          outcome: "internal",
          smtpCode: null,
          durationMs: 0,
        });
        const nextDueAt = row.cadence === "off" ? null : nextDue(scheduleSettingsOf(row), row.lastSentAt, at);
        await tx
          .update(s)
          .set({ leaseOwner: null, leaseUntil: null, lastAttemptAt: at, lastOutcome: "internal", nextDueAt })
          .where(eq(s.userId, row.userId));
      }
      return stale.length;
    });
  });
}

/** Claims due people, longest-overdue first (`FOR UPDATE SKIP LOCKED`), one lease per person (E7, E11). */
export async function claimDuePeople(db: Database, opts: { limit: number; leaseSeconds: number; now: Date }): Promise<ClaimedPerson[]> {
  return runCrossProject("scheduler: claim email claims", async () => {
    const token = randomUUID();
    const leaseUntil = new Date(opts.now.getTime() + opts.leaseSeconds * 1000);
    return db.transaction(async (tx) => {
      const s = emailSettings;
      const due = await tx
        .select()
        .from(s)
        .where(and(sql`${s.cadence} <> 'off'`, isNull(s.pausedAt), isNull(s.leaseOwner), lte(s.nextDueAt, opts.now)))
        .orderBy(asc(s.nextDueAt))
        .limit(opts.limit)
        .for("update", { skipLocked: true });
      const claimed: ClaimedPerson[] = [];
      for (const row of due) {
        const [updated] = await tx.update(s).set({ leaseOwner: token, leaseUntil }).where(eq(s.userId, row.userId)).returning();
        claimed.push({ settings: updated!, token });
      }
      return claimed;
    });
  });
}

/** Releases a claim with no attempt row — not enough time left in the tick, or nothing was eligible (N52). */
export async function releaseClaim(db: Database, userId: string, token: string, nextDueAt: Date | null): Promise<void> {
  await runCrossProject("scheduler: release email claim", async () => {
    await db
      .update(emailSettings)
      .set({ leaseOwner: null, leaseUntil: null, nextDueAt })
      .where(and(eq(emailSettings.userId, userId), eq(emailSettings.leaseOwner, token)));
  });
}

/** Writes the high-water of the message about to be sent, under the lease (E9 step 4). */
export async function markInFlight(
  db: Database,
  claim: ClaimedPerson,
  perProject: { projectId: string; maxSeq: bigint }[],
): Promise<"ok" | "stale"> {
  return runCrossProject("scheduler: mark email in flight", async () => {
    return db.transaction(async (tx) => {
      const locked = await tx
        .select({ userId: emailSettings.userId })
        .from(emailSettings)
        .where(and(eq(emailSettings.userId, claim.settings.userId), eq(emailSettings.leaseOwner, claim.token)))
        .for("update");
      if (locked.length === 0) return "stale";
      for (const p of perProject) {
        await tx
          .insert(emailProjectState)
          .values({ projectId: p.projectId, userId: claim.settings.userId, sendingSeq: p.maxSeq })
          .onConflictDoUpdate({
            target: [emailProjectState.projectId, emailProjectState.userId],
            set: {
              sendingSeq: sql`GREATEST(COALESCE(${emailProjectState.sendingSeq}, 0), ${p.maxSeq.toString()}::bigint)`,
              updatedAt: sql`now()`,
            },
          });
      }
      return "ok";
    });
  });
}

export interface RecordAttemptInput {
  purpose: "problems" | "invitation";
  cadence: "immediate" | "digest" | null;
  problemCount: number;
  smtpCode: number | null;
  durationMs: number;
}

export interface EmailRecordResult {
  outcome: EmailOutcomeClass;
  disposition: "sent" | "retry" | "paused" | "unavailable";
}

export interface RecordAttemptConfig {
  backoffBaseMs: number;
  backoffMaxMs: number;
  pauseAfterFailures: number;
  unavailableRetryMs: number;
}

/** data-model.md §5 step 6: always an attempt row, then the outcome's own branch. Lease verified. */
export async function recordAttempt(
  db: Database,
  claim: ClaimedPerson,
  input: RecordAttemptInput,
  outcome: EmailOutcomeClass,
  cfg: RecordAttemptConfig,
): Promise<"stale" | EmailRecordResult> {
  return runCrossProject("scheduler: record email attempt", async () => {
    const at = await now(db);
    return db.transaction(async (tx) => {
      const s = emailSettings;
      const locked = await tx
        .select()
        .from(s)
        .where(and(eq(s.userId, claim.settings.userId), eq(s.leaseOwner, claim.token)))
        .for("update");
      const row = locked[0];
      if (!row) return "stale";

      await tx.insert(emailDeliveryAttempts).values({
        userId: row.userId,
        at,
        purpose: input.purpose,
        cadence: input.cadence,
        problemCount: input.problemCount,
        outcome,
        smtpCode: input.smtpCode,
        durationMs: input.durationMs,
      });

      const base = { leaseOwner: null, leaseUntil: null, lastAttemptAt: at, lastOutcome: outcome };
      const clearSending = () =>
        tx
          .update(emailProjectState)
          .set({ sendingSeq: null, updatedAt: at })
          .where(and(eq(emailProjectState.userId, row.userId), isNotNull(emailProjectState.sendingSeq)));

      if (outcome === "sent") {
        await tx
          .update(emailProjectState)
          .set({
            mailedSeq: sql`GREATEST(${emailProjectState.mailedSeq}, COALESCE(${emailProjectState.sendingSeq}, ${emailProjectState.mailedSeq}))`,
            sendingSeq: null,
            updatedAt: at,
          })
          .where(and(eq(emailProjectState.userId, row.userId), isNotNull(emailProjectState.sendingSeq)));
        const nextDueAt = nextDue(scheduleSettingsOf(row), at, at);
        await tx.update(s).set({ ...base, lastSentAt: at, consecutiveFailures: 0, nextDueAt }).where(eq(s.userId, row.userId));
        return { outcome, disposition: "sent" };
      }
      if (outcome === "rejected") {
        await clearSending();
        await tx.update(s).set({ ...base, pausedAt: at, pausedReason: "rejected" }).where(eq(s.userId, row.userId));
        return { outcome, disposition: "paused" };
      }
      if (outcome === "unavailable") {
        await clearSending();
        const nextDueAt = new Date(at.getTime() + cfg.unavailableRetryMs);
        await tx.update(s).set({ ...base, nextDueAt }).where(eq(s.userId, row.userId));
        return { outcome, disposition: "unavailable" };
      }
      // temporary: refused | timed_out | connect_failed | tls_failed | internal
      await clearSending();
      const failures = row.consecutiveFailures + 1;
      if (failures >= cfg.pauseAfterFailures) {
        await tx
          .update(s)
          .set({ ...base, consecutiveFailures: failures, pausedAt: at, pausedReason: "failing" })
          .where(eq(s.userId, row.userId));
        return { outcome, disposition: "paused" };
      }
      const delay = Math.min(cfg.backoffBaseMs * 2 ** (failures - 1), cfg.backoffMaxMs);
      const nextDueAt = new Date(at.getTime() + delay);
      await tx.update(s).set({ ...base, consecutiveFailures: failures, nextDueAt }).where(eq(s.userId, row.userId));
      return { outcome, disposition: "retry" };
    });
  });
}

/**
 * One attempt row for one invitation send, no lease (E24, E26). `userId` is `null` when the invitee has
 * no Docket account — there is no person to reference and FR-033 forbids storing the address.
 */
export async function recordInvitationAttempt(
  db: Database,
  userId: string | null,
  outcome: EmailOutcomeClass,
  smtpCode: number | null,
  durationMs: number,
): Promise<void> {
  await runCrossProject("scheduler: record invitation attempt", async () => {
    const at = await now(db);
    await db.insert(emailDeliveryAttempts).values({
      userId,
      at,
      purpose: "invitation",
      cadence: null,
      problemCount: 0,
      outcome,
      smtpCode,
      durationMs,
    });
  });
}

/** Retention cleanup, bounded per statement (the webhook log's shape). */
export async function purgeEmailHistory(db: Database, retentionDays: number, limit = 500): Promise<number> {
  return runCrossProject("scheduler: email housekeeping", async () => {
    const at = await now(db);
    const cutoff = new Date(at.getTime() - retentionDays * 86_400_000);
    const a = emailDeliveryAttempts;
    const old = await db.select({ id: a.id }).from(a).where(lt(a.at, cutoff)).limit(limit);
    if (old.length === 0) return 0;
    const removed = await db.delete(a).where(inArray(a.id, old.map((x) => x.id))).returning({ id: a.id });
    return removed.length;
  });
}

/** This person's compiled plan for one project (data-model.md §6.2) — loaded fresh, never cached. */
export async function planForProject(db: Database, projectId: string, userId: string): Promise<EligibilityPlan> {
  return runCrossProject("scheduler: email preferences", async () => {
    const rows = await db
      .select({ axis: notificationPreferences.axis, switchKey: notificationPreferences.switchKey, onFromSeq: notificationPreferences.onFromSeq })
      .from(notificationPreferences)
      .where(and(eq(notificationPreferences.projectId, projectId), eq(notificationPreferences.userId, userId)));
    const preferenceRows: PreferenceRow[] = rows.map((r) => ({ axis: r.axis as SwitchAxis, switchKey: r.switchKey, onFromSeq: r.onFromSeq }));
    return compileEligibility(preferencesOf(preferenceRows));
  });
}

/** Whether any kind switch is on in any of the given projects — the `allSwitchesOff` hint (FR-038). */
export async function anySwitchOn(db: Database, userId: string, projectIds: readonly string[]): Promise<boolean> {
  if (projectIds.length === 0) return false;
  return runCrossProject("email: preference check", async () => {
    for (const projectId of projectIds) {
      const plan = await planForProject(db, projectId, userId);
      if (plan.memberGroups.length > 0 || plan.connectFailed) return true;
    }
    return false;
  });
}

// ---- Assembly's reads, all pinned per project inside the cross-project section ----

export interface ProjectForEmail {
  projectId: string;
  slug: string;
  name: string;
  timeZone: string;
  mailedSeq: bigint;
  excluded: boolean;
  seenSeq: bigint;
}

/** One statement, one user id: every project the person is a member of, with their email and read state. */
export async function projectsForEmail(db: Database, userId: string): Promise<ProjectForEmail[]> {
  return runCrossProject("scheduler: email projects for person", async () => {
    const rows = await db
      .select({
        projectId: projects.id,
        slug: projects.slug,
        name: projects.name,
        timeZone: projects.timezone,
        mailedSeq: emailProjectState.mailedSeq,
        excluded: emailProjectState.excluded,
        seenSeq: notificationStates.seenSeq,
      })
      .from(member)
      .innerJoin(projects, eq(projects.id, member.organizationId))
      .leftJoin(notificationStates, and(eq(notificationStates.projectId, member.organizationId), eq(notificationStates.userId, member.userId)))
      .leftJoin(emailProjectState, and(eq(emailProjectState.projectId, member.organizationId), eq(emailProjectState.userId, member.userId)))
      .where(eq(member.userId, userId));
    return rows.map((r) => ({
      projectId: r.projectId,
      slug: r.slug,
      name: r.name,
      timeZone: r.timeZone,
      mailedSeq: r.mailedSeq ?? 0n,
      excluded: r.excluded ?? false,
      seenSeq: r.seenSeq ?? 0n,
    }));
  });
}
