import { count } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { getDb, type Database } from "../db/client";
import { account, installState, user } from "../db/schema";
import { SetupUnavailableError } from "./errors";
import { crossProject } from "./scope";

export interface FirstUserInput {
  name: string;
  email: string;
  password: string;
}

/** Setup is offered only while there is no `install_state` row and no user (research D13). */
export async function isSetupAvailable(db: Database = getDb()): Promise<boolean> {
  return crossProject("install", async () => {
    const [installed] = await db.select({ n: count() }).from(installState);
    if ((installed?.n ?? 0) > 0) return false;
    const [users] = await db.select({ n: count() }).from(user);
    return (users?.n ?? 0) === 0;
  });
}

/**
 * Creates the first account in one transaction. The `install_state` singleton insert is the
 * lock: a concurrent second attempt blocks on the primary key and then conflicts, which is
 * reported as `SetupUnavailableError` (FR-012).
 */
export async function bootstrapFirstUser(
  input: FirstUserInput,
  db: Database = getDb(),
): Promise<{ userId: string }> {
  const passwordHash = await hashPassword(input.password);
  return crossProject("install", async () => {
    try {
      return await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(installState)
          .values({ id: 1 })
          .onConflictDoNothing()
          .returning({ id: installState.id });
        if (inserted.length === 0) throw new SetupUnavailableError();

        const [existing] = await tx.select({ n: count() }).from(user);
        if ((existing?.n ?? 0) > 0) throw new SetupUnavailableError();

        const [created] = await tx
          .insert(user)
          .values({ name: input.name, email: input.email.trim().toLowerCase(), emailVerified: false })
          .returning({ id: user.id });
        if (!created) throw new Error("User insert returned no row");
        await tx.insert(account).values({
          userId: created.id,
          accountId: created.id,
          providerId: "credential",
          password: passwordHash,
        });
        await tx.update(installState).set({ firstUserId: created.id });
        return { userId: created.id };
      });
    } catch (error) {
      // 23505 = unique_violation: the loser of a race on the singleton row.
      if ((error as { code?: string }).code === "23505") throw new SetupUnavailableError();
      throw error;
    }
  });
}
