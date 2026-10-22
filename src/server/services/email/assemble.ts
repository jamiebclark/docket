// One person, at this instant, through the one eligibility rule (FR-009, FR-011, FR-012). Reads only;
// runs inside the scheduler's named cross-project section (FR-043).
import {
  mintUnsubscribeToken,
  oneClickUnsubscribeUrl,
  unsubscribeUrl as buildUnsubscribeUrl,
  type UnsubscribeGrant,
} from "../../../lib/email/unsubscribe";
import type { EmailProblem, EmailProjectGroup, ProblemEmailModel } from "../../../lib/email/render";
import { countAttentionForEmail, listAttentionForEmail, type AttentionRecord } from "../../dal/activity";
import { emailDb, planForProject, projectsForEmail } from "../../dal/email";
import { getEnv } from "../../env";
import { OUTCOME_LABEL, type ActivityOutcome } from "../../../lib/activity/outcomes";
import { recordAccount, recordLink, recordPlatforms } from "../activity";

/** The newest rows listed per project, and the scan bound for the exact overflow count (E16). */
export const EMAIL_LIST_LIMIT = 20;
export const EMAIL_SCAN_LIMIT = 1000;

export interface AssembledMessage {
  model: ProblemEmailModel;
  /** The RFC 8058 one-click endpoint for this message's token (docs/research/smtp.md). */
  oneClickUrl: string;
  problemCount: number;
  /** One per project with anything in it: what `markInFlight` writes (data-model.md §5 step 4). */
  highWater: { projectId: string; maxSeq: bigint }[];
}

function maxBigint(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * FR-011 requires every mailed row to carry a link, and `recordLink` legitimately returns nothing for
 * some rows — a deleted post, say. The project's own Activity screen is the floor, so a message never
 * again arrives with nothing to click (020 feedback).
 */
function toEmailProblem(record: AttentionRecord, projectSlug: string): EmailProblem {
  const link = recordLink(record) ?? { href: `/p/${projectSlug}/activity`, label: "Open Activity" };
  return {
    outcome: record.outcome as ActivityOutcome,
    outcomeLabel: OUTCOME_LABEL[record.outcome],
    occurredAt: record.occurredAt,
    platforms: recordPlatforms(record),
    accountName: recordAccount(record)?.name ?? null,
    message: record.message,
    href: `${getEnv().BETTER_AUTH_URL}${link.href}`,
    actionLabel: link.label,
  };
}

/**
 * One person, through the one eligibility rule. `null` when nothing is eligible — the caller then sends
 * nothing and moves no position (N52, FR-013). Reads only; runs inside the scheduler's cross-project
 * section (FR-043).
 */
export async function assembleForPerson(input: {
  userId: string;
  cadence: "immediate" | "digest";
  zone: string;
  now: Date;
}): Promise<AssembledMessage | null> {
  const db = emailDb();
  const projectsList = [...(await projectsForEmail(db, input.userId))].sort((a, b) => a.name.localeCompare(b.name));

  const groups: EmailProjectGroup[] = [];
  const highWater: { projectId: string; maxSeq: bigint }[] = [];
  const contributingProjectIds: string[] = [];
  let problemCount = 0;

  for (const project of projectsList) {
    if (project.excluded) continue;
    const plan = await planForProject(db, project.projectId, input.userId);
    if (plan.memberGroups.length === 0 && !plan.connectFailed) continue;
    const minSeq = maxBigint(project.seenSeq, project.mailedSeq);

    const [items, counted] = await Promise.all([
      listAttentionForEmail(db, { projectId: project.projectId, userId: input.userId, limit: EMAIL_LIST_LIMIT, plan, minSeq }),
      countAttentionForEmail(db, { projectId: project.projectId, userId: input.userId, scanLimit: EMAIL_SCAN_LIMIT, plan, minSeq }),
    ]);
    if (counted.total === 0) continue;

    const overflow = Math.max(counted.total - items.length, 0);
    groups.push({
      name: project.name,
      problems: items.map((item) => toEmailProblem(item, project.slug)),
      overflow,
      // Activity, not Failures: an overflow can hold inbox messages and reconnect prompts, which the
      // Failures screen does not list at all, and FR-011 asks for a link into Activity.
      overflowHref: `${getEnv().BETTER_AUTH_URL}/p/${project.slug}/activity`,
    });
    contributingProjectIds.push(project.projectId);
    highWater.push({ projectId: project.projectId, maxSeq: counted.maxSeq ?? minSeq });
    problemCount += counted.total;
  }

  if (groups.length === 0) return null;

  const grant: UnsubscribeGrant = { userId: input.userId, projectId: contributingProjectIds.length === 1 ? contributingProjectIds[0]! : null };
  const token = mintUnsubscribeToken(grant, input.now);

  return {
    model: { cadence: input.cadence, timeZone: input.zone, groups, unsubscribeUrl: buildUnsubscribeUrl(token) },
    oneClickUrl: oneClickUnsubscribeUrl(token),
    problemCount,
    highWater,
  };
}
