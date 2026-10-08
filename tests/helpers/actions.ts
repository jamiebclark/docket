import type { SessionLike } from "../../src/server/dal/scope";

/**
 * Server-action test plumbing (research D19). In the test file:
 *
 *   vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
 *   vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
 *   vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);
 *
 * then `actAs(user)` before each action call (`actAs(null)` = signed out).
 */
let current: (SessionLike & { session: { id: string } }) | null = null;

export function actAs(user: { id: string; email?: string; name?: string } | null, sessionId = "00000000-0000-4000-8000-000000000000"): void {
  current = user ? { user: { ...user, id: user.id }, session: { id: sessionId } } : null;
}

export class RedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`);
    this.name = "RedirectSignal";
  }
}
export class NotFoundSignal extends Error {
  constructor() {
    super("notFound");
    this.name = "NotFoundSignal";
  }
}

export const refreshCalls = { count: 0 };

export const sessionModule = { getSession: async () => current };
export const cacheModule = {
  refresh: () => {
    refreshCalls.count++;
  },
  revalidatePath: () => {},
};
export const navigationModule = {
  redirect: (to: string): never => {
    throw new RedirectSignal(to);
  },
  notFound: (): never => {
    throw new NotFoundSignal();
  },
};
