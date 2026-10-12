import { getDb } from "../../src/server/db/client";
import { runCrossProject } from "../../src/server/db/cross-project";
import { emailSettings } from "../../src/server/db/schema";
import { addMember, createProject, createUser } from "./factories";
import { recordEvent } from "./notifications";

export interface SeedEmailSettingsOptions {
  cadence?: "off" | "immediate" | "digest";
  digestHour?: number;
  timeZone?: string | null;
  quietStartHour?: number | null;
  quietEndHour?: number | null;
  nextDueAt?: Date | null;
  pausedAt?: Date | null;
  pausedReason?: "rejected" | "failing" | null;
  consecutiveFailures?: number;
  lastSentAt?: Date | null;
}

/** Writes an `email_settings` row directly, bypassing the service layer (for test setup, not for product paths). */
export async function seedEmailSettings(userId: string, opts: SeedEmailSettingsOptions = {}) {
  const cadence = opts.cadence ?? "immediate";
  return runCrossProject("test: seed email settings", async () => {
    const [row] = await getDb()
      .insert(emailSettings)
      .values({
        userId,
        cadence,
        digestHour: opts.digestHour ?? 7,
        timeZone: opts.timeZone ?? null,
        quietStartHour: opts.quietStartHour ?? null,
        quietEndHour: opts.quietEndHour ?? null,
        nextDueAt: opts.nextDueAt !== undefined ? opts.nextDueAt : cadence === "off" ? null : new Date(),
        pausedAt: opts.pausedAt ?? null,
        pausedReason: opts.pausedReason ?? null,
        consecutiveFailures: opts.consecutiveFailures ?? 0,
        lastSentAt: opts.lastSentAt ?? null,
      })
      .onConflictDoUpdate({
        target: emailSettings.userId,
        set: {
          cadence,
          digestHour: opts.digestHour ?? 7,
          timeZone: opts.timeZone ?? null,
          quietStartHour: opts.quietStartHour ?? null,
          quietEndHour: opts.quietEndHour ?? null,
          nextDueAt: opts.nextDueAt !== undefined ? opts.nextDueAt : cadence === "off" ? null : new Date(),
          pausedAt: opts.pausedAt ?? null,
          pausedReason: opts.pausedReason ?? null,
          consecutiveFailures: opts.consecutiveFailures ?? 0,
          lastSentAt: opts.lastSentAt ?? null,
        },
      })
      .returning();
    return row!;
  });
}

/** A person whose immediate email is on and due right now — the common fixture for the tick tests. */
export async function seedDuePerson(opts: SeedEmailSettingsOptions = {}) {
  const user = await createUser();
  await seedEmailSettings(user.id, { cadence: "immediate", nextDueAt: new Date(), ...opts });
  return user;
}

/** A project with one member and one failed event — the minimal thing email has something to say about. */
export async function seedProjectWithProblem(userId?: string) {
  const project = await createProject();
  const user = userId ? { id: userId } : await createUser();
  await addMember(project.id, user.id, "owner");
  const event = await recordEvent(project.id, "account_needs_reauth");
  return { project, user, event };
}
