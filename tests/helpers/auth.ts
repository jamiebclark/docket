import { randomUUID } from "node:crypto";
import type { SessionLike } from "../../src/server/dal/scope";
import { createSession } from "./factories";

/** A fake session for DAL tests (the DAL only reads `user.id`). */
export function fakeSession(userId: string = randomUUID()): SessionLike {
  return { user: { id: userId } };
}

/**
 * A session backed by a real `session` row, for anything that reads the table — the stream's
 * `sessionIsLive` re-check and its own re-check timer (data-model.md §5.3). `actAs`'s default session
 * id exists in no table, which is fine for server actions but not for this.
 */
export async function liveSession(userId: string): Promise<SessionLike & { session: { id: string } }> {
  const row = await createSession(userId);
  return { user: { id: userId }, session: { id: row.id } };
}
