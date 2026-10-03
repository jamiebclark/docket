import { forProject } from "../../src/server/dal/scope";
import * as accounts from "../../src/server/services/accounts";
import * as slots from "../../src/server/services/slots";
import { fakeSession } from "./auth";
import { createProjectWithMembers } from "./factories";

/** A project with an owner scope, and helpers to add mock accounts (optionally with a Monday 09:00 slot). */
export async function postsEnv() {
  const ctx = await createProjectWithMembers();
  const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
  const as = (u: { id: string }) => forProject(fakeSession(u.id), ctx.project.slug);
  async function account(settings: Record<string, unknown> = {}, withSlot = true) {
    const a = await accounts.connectMock(scope, { displayName: `Mock ${Math.random().toString(36).slice(2, 7)}`, settings });
    if (withSlot) await slots.addSlot(scope, { accountId: a.id, weekday: 1, localTime: "09:00" });
    return a;
  }
  return { ...ctx, scope, as, account };
}
