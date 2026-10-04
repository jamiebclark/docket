import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import ConnectChooserPage from "../../../src/app/p/[projectSlug]/accounts/connect/[attemptId]/page";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import * as connect from "../../../src/server/services/connect";
import { actAs, NotFoundSignal } from "../../helpers/actions";
import { closeDb, testDb } from "../../helpers/db";
import { pageCandidate, readyAttempt, registerThrowaway, sessionFor, unregisterThrowaway } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";

beforeAll(registerThrowaway);
afterAll(async () => {
  unregisterThrowaway();
  await closeDb();
});

describe("chooser page", () => {
  it("renders labelled nested checkboxes, notes and marks, and no secret", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    // An already-connected Page.
    const first = await readyAttempt(env.scope, session, pageCandidate("100", "Acme", false));
    await connect.chooseConnectCandidates(env.scope, { attemptId: first, selected: ["tw-page:100"] }, session);
    const id = await readyAttempt(env.scope, session, [...pageCandidate("100", "Acme", false), ...pageCandidate("200", "Beta")]);

    // The page reads the session from Better Auth; the test session module returns only the user, so add the id.
    const { sessionModule } = await import("../../helpers/actions");
    const original = sessionModule.getSession;
    sessionModule.getSession = (async () => ({ user: { id: env.owner.id }, session: { id: session.sessionId } })) as never;
    try {
      const element = await ConnectChooserPage({ params: Promise.resolve({ projectSlug: env.project.slug, attemptId: id }) });
      const html = renderToStaticMarkup(element);
      expect(html).toContain("<fieldset");
      expect(html).toContain("<legend");
      expect(html.match(/type="checkbox"/g)).toHaveLength(3);
      expect(html).toContain('for="candidate-tw-page-200"');
      expect(html).toContain("Beta · Photos");
      expect(html).toContain("Already connected");
      expect(html).toContain("No photo account is linked.");
      expect(html).not.toMatch(/PAGE-TOKEN|enc:v1|pageToken|credentials/i);
    } finally {
      sessionModule.getSession = original;
    }
    const rows = await testDb().select().from(socialAccounts).where(eq(socialAccounts.projectId, env.project.id));
    expect(rows).toHaveLength(1);
  });

  it("is not found for editors", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const id = await readyAttempt(env.scope, session, pageCandidate("100", "Acme"));
    const { sessionModule } = await import("../../helpers/actions");
    const original = sessionModule.getSession;
    sessionModule.getSession = (async () => ({ user: { id: env.editor.id }, session: { id: session.sessionId } })) as never;
    actAs(null);
    try {
      await expect(
        ConnectChooserPage({ params: Promise.resolve({ projectSlug: env.project.slug, attemptId: id }) }),
      ).rejects.toBeInstanceOf(NotFoundSignal);
    } finally {
      sessionModule.getSession = original;
    }
  });
});
