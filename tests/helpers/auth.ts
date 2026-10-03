import { randomUUID } from "node:crypto";
import type { SessionLike } from "../../src/server/dal/scope";

/** A fake session for DAL tests (the DAL only reads `user.id`). */
export function fakeSession(userId: string = randomUUID()): SessionLike {
  return { user: { id: userId } };
}
