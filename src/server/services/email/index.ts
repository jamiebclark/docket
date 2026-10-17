// What the screens call for their own settings (contracts/services.md §5 "index.ts"), and the
// unsubscribe path's token-based operations (US4).
import { z } from "zod";
import { CADENCES, type Cadence } from "../../../lib/email/schedule";
import { readUnsubscribeToken } from "../../../lib/email/unsubscribe";
import { isValidTimeZone, timeZoneSchema } from "../../../lib/validation/timezone";
import {
  anySwitchOn as dalAnySwitchOn,
  emailDb,
  excludeProject,
  includeProject,
  lastAttempts,
  projectsForEmail,
  readSettings,
  resumeEmail,
  setCadence,
  upsertSettings,
} from "../../dal/email";
import type { SessionLike } from "../../dal/scope";
import { getEnv } from "../../env";
import { getMailer, unavailableMailer } from "../../mail";

/**
 * Whether this install can send mail at all, with no session needed. The signed-out pages use it: the
 * sign-in page only offers "Forgot your password?" when an email could actually arrive, because a
 * reset form that silently posts into the void is worse than no link at all (FR-002).
 */
export function emailAvailable(): boolean {
  return getMailer() !== null;
}

export class EmailUnavailableError extends Error {
  constructor() {
    super("Email is not available on this install");
    this.name = "EmailUnavailableError";
  }
}

export interface MyEmailSettings {
  available: boolean;
  transportAvailable: boolean;
  cadence: Cadence;
  digestHour: number;
  timeZone: string;
  zoneSource: "chosen" | "projects" | "utc" | "unknown";
  quiet: { startHour: number; endHour: number } | null;
  paused: { at: Date; reason: "rejected" | "failing" } | null;
  last: { at: Date; outcome: string; sent: boolean } | null;
  lastSentAt: Date | null;
  projects: { slug: string; name: string; excluded: boolean }[];
  immediateIntervalSeconds: number;
  anySwitchOn: boolean;
}

function zoneInfo(stored: string | null, projectZones: readonly string[]): { zone: string; source: MyEmailSettings["zoneSource"] } {
  if (stored) {
    if (!isValidTimeZone(stored)) return { zone: "UTC", source: "unknown" };
    return { zone: stored, source: "chosen" };
  }
  if (projectZones.length === 0) return { zone: "UTC", source: "utc" };
  const first = projectZones[0]!;
  return projectZones.every((z) => z === first) ? { zone: first, source: "projects" } : { zone: "UTC", source: "utc" };
}

/** The caller's own, always. Never takes a user id (FR-010, FR-044). */
export async function myEmailSettings(session: SessionLike): Promise<MyEmailSettings> {
  const userId = session.user.id;
  const db = emailDb();
  const [settingsRow, projectsList, attempts] = await Promise.all([
    readSettings(db, userId),
    projectsForEmail(db, userId),
    lastAttempts(db, userId, 1),
  ]);

  const mailer = getMailer();
  const available = mailer !== null;
  const transportAvailable = available && mailer !== unavailableMailer;

  const { zone, source } = zoneInfo(settingsRow?.timeZone ?? null, projectsList.map((p) => p.timeZone));
  const last = attempts[0] ? { at: attempts[0].at, outcome: attempts[0].outcome, sent: attempts[0].outcome === "sent" } : null;
  const anySwitchOn = await dalAnySwitchOn(db, userId, projectsList.map((p) => p.projectId));

  return {
    available,
    transportAvailable,
    cadence: (settingsRow?.cadence as Cadence) ?? "off",
    digestHour: settingsRow?.digestHour ?? 7,
    timeZone: zone,
    zoneSource: source,
    quiet:
      settingsRow?.quietStartHour != null && settingsRow?.quietEndHour != null
        ? { startHour: settingsRow.quietStartHour, endHour: settingsRow.quietEndHour }
        : null,
    paused: settingsRow?.pausedAt && settingsRow.pausedReason ? { at: settingsRow.pausedAt, reason: settingsRow.pausedReason as "rejected" | "failing" } : null,
    last,
    lastSentAt: settingsRow?.lastSentAt ?? null,
    projects: projectsList.map((p) => ({ slug: p.slug, name: p.name, excluded: p.excluded })),
    immediateIntervalSeconds: getEnv().WORKER_INTERVAL_SECONDS,
    anySwitchOn,
  };
}

const emailSettingsSchema = z
  .object({
    cadence: z.enum(CADENCES),
    digestHour: z.coerce.number().int().min(0).max(23),
    timeZone: timeZoneSchema,
    quietStartHour: z.coerce.number().int().min(0).max(23).nullable(),
    quietEndHour: z.coerce.number().int().min(0).max(23).nullable(),
  })
  .transform((v) => {
    const pair = v.quietStartHour !== null && v.quietEndHour !== null && v.quietStartHour !== v.quietEndHour;
    return { ...v, quietStartHour: pair ? v.quietStartHour : null, quietEndHour: pair ? v.quietEndHour : null };
  });

/** Zod-validated; recomputes `next_due_at` in the same transaction (FR-020). */
export async function saveMyEmailSettings(session: SessionLike, input: unknown): Promise<MyEmailSettings> {
  if (getMailer() === null) throw new EmailUnavailableError();
  const patch = emailSettingsSchema.parse(input);
  await upsertSettings(emailDb(), session.user.id, patch);
  return myEmailSettings(session);
}

/** Clears the pause and the failure count, rolls `next_due_at` forward (FR-023, N61). */
export async function resumeMyEmail(session: SessionLike): Promise<MyEmailSettings> {
  await resumeEmail(emailDb(), session.user.id);
  return myEmailSettings(session);
}

/** Reverses a per-project unsubscribe. The caller's own, current project set is resolved first (FR-044). */
export async function includeMyProject(session: SessionLike, projectSlug: string): Promise<MyEmailSettings> {
  const db = emailDb();
  const projectsList = await projectsForEmail(db, session.user.id);
  const target = projectsList.find((p) => p.slug === projectSlug);
  if (target) await includeProject(db, session.user.id, target.projectId);
  return myEmailSettings(session);
}

// ---- Unsubscribe: every operation takes a token, never a user id (FR-029, FR-044) ----

export type UnsubscribeAction =
  | { kind: "all_off" }
  | { kind: "project_off"; projectSlug: string }
  | { kind: "digest" }
  | { kind: "back_on" };

export interface UnsubscribeView {
  /** False for every refusal: tampered, truncated, expired, re-signed, rotated key, deleted person. */
  valid: boolean;
  cadence: Cadence;
  digestHour: number;
  timeZone: string;
  projects: { slug: string; name: string; excluded: boolean }[];
  /** The project the token named, when it named one and the person is still a member (E20). */
  focusSlug: string | null;
}

const NEUTRAL_VIEW: UnsubscribeView = { valid: false, cadence: "off", digestHour: 7, timeZone: "UTC", projects: [], focusSlug: null };

async function viewForUser(userId: string, focusProjectId: string | null): Promise<UnsubscribeView> {
  const db = emailDb();
  const [settingsRow, projectsList] = await Promise.all([readSettings(db, userId), projectsForEmail(db, userId)]);
  if (!settingsRow) return NEUTRAL_VIEW;
  const focus = focusProjectId ? projectsList.find((p) => p.projectId === focusProjectId) : undefined;
  return {
    valid: true,
    cadence: settingsRow.cadence as Cadence,
    digestHour: settingsRow.digestHour,
    timeZone: settingsRow.timeZone ?? "UTC",
    projects: projectsList.map((p) => ({ slug: p.slug, name: p.name, excluded: p.excluded })),
    focusSlug: focus?.slug ?? null,
  };
}

/** Reads only. A GET must never write (N57, FR-027). */
export async function readUnsubscribe(token: unknown, now: Date): Promise<UnsubscribeView> {
  const grant = readUnsubscribeToken(token, now);
  if (!grant) return NEUTRAL_VIEW;
  return viewForUser(grant.userId, grant.projectId);
}

/** Idempotent. Every refusal returns `{ valid: false }` having written nothing (FR-029). */
export async function applyUnsubscribe(token: unknown, action: UnsubscribeAction, now: Date): Promise<UnsubscribeView> {
  const grant = readUnsubscribeToken(token, now);
  if (!grant) return NEUTRAL_VIEW;
  const db = emailDb();
  const { userId } = grant;

  if (action.kind === "all_off") {
    const result = await setCadence(db, userId, "off");
    if (result === "no_person") return NEUTRAL_VIEW;
    return viewForUser(userId, grant.projectId);
  }
  if (action.kind === "digest") {
    const result = await setCadence(db, userId, "digest");
    if (result === "no_person") return NEUTRAL_VIEW;
    return viewForUser(userId, grant.projectId);
  }
  if (action.kind === "back_on") {
    const result = await setCadence(db, userId, "immediate");
    if (result === "no_person") return NEUTRAL_VIEW;
    return viewForUser(userId, grant.projectId);
  }

  // project_off: the caller's own, current project set is resolved first (FR-029, FR-044, N41).
  const projectsList = await projectsForEmail(db, userId);
  const target = projectsList.find((p) => p.slug === action.projectSlug);
  if (!target) return NEUTRAL_VIEW;
  const result = await excludeProject(db, userId, target.projectId);
  if (result === "not_member") return NEUTRAL_VIEW;
  return viewForUser(userId, grant.projectId);
}
