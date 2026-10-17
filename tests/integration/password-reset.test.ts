// The emailed password reset end to end: Better Auth mints and consumes the token, Docket's own
// delivery turns it into one message and one `password_reset` attempt row, and the request endpoint
// stays silent about whether an address has an account.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../../src/server/auth/auth";
import { getDb } from "../../src/server/db/client";
import { runCrossProject } from "../../src/server/db/cross-project";
import { account, emailDeliveryAttempts, session as sessionTable } from "../../src/server/db/schema";
import { setMailerForTests } from "../../src/server/mail";
import { closeDb } from "../helpers/db";
import { createSession, createUser } from "../helpers/factories";
import { recordingMailer } from "../helpers/mailer";

// The two actions read request headers; outside a request there are none, and none are needed —
// Better Auth only uses them to resolve a session, and both of these paths are for signed-out people.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", async () => (await import("../helpers/actions")).navigationModule);

import { RedirectSignal } from "../helpers/actions";
import { RESET_REQUESTED_MESSAGE } from "../../src/lib/auth-text";
import { requestPasswordReset } from "../../src/app/forgot-password/actions";
import { resetPassword } from "../../src/app/reset-password/actions";

afterAll(closeDb);

const mailer = recordingMailer();

beforeEach(() => {
  setMailerForTests(mailer);
});

afterEach(() => {
  mailer.reset();
  setMailerForTests(undefined);
});

const OLD_PASSWORD = "old-correct-horse-battery";
const NEW_PASSWORD = "new-correct-horse-battery";

let seq = 0;
/** A distinct address per test: the reset limiter is per-email module state shared across this file. */
const freshEmail = () => `reset-${Date.now().toString(36)}-${seq++}@example.test`;

/** A user with a credential account, so "the old password stops working" is a real assertion. */
async function userWithPassword(email: string, password = OLD_PASSWORD) {
  const row = await createUser({ email });
  const passwordHash = await hashPassword(password);
  await runCrossProject("test: seed credential account", async () => {
    await getDb().insert(account).values({
      userId: row.id,
      accountId: row.id,
      providerId: "credential",
      password: passwordHash,
    });
  });
  return row;
}

const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(entries)) data.set(k, v);
  return data;
};

async function attemptRows(userId: string) {
  return runCrossProject("test: read email attempts", async () =>
    getDb().select().from(emailDeliveryAttempts).where(eq(emailDeliveryAttempts.userId, userId)),
  );
}

async function sessionRows(userId: string) {
  return runCrossProject("test: read sessions", async () =>
    getDb().select().from(sessionTable).where(eq(sessionTable.userId, userId)),
  );
}

/** The raw token out of the emailed URL — the only place it ever exists in plaintext. */
function tokenFromEmail(text: string): string {
  const match = /\/reset-password\/([^?\s]+)/.exec(text);
  if (!match) throw new Error(`no reset token in message: ${text}`);
  return match[1]!;
}

async function signIn(email: string, password: string) {
  return getAuth().api.signInEmail({ body: { email, password }, headers: new Headers() });
}

describe("requesting a reset", () => {
  it("emails one message carrying a token, and records a sent password_reset attempt", async () => {
    const email = freshEmail();
    const person = await userWithPassword(email);

    const result = await requestPasswordReset(null, form({ email }));

    expect(result.ok).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(email);
    expect(mailer.sent[0]!.subject).toBe("Reset your Docket password");
    expect(() => tokenFromEmail(mailer.sent[0]!.text)).not.toThrow();

    const rows = await attemptRows(person.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.purpose).toBe("password_reset");
    expect(rows[0]!.outcome).toBe("sent");
    expect(rows[0]!.cadence).toBeNull();
  });

  it("says exactly the same thing for an address with no account, and sends nothing", async () => {
    const known = freshEmail();
    await userWithPassword(known);
    const hit = await requestPasswordReset(null, form({ email: known }));
    mailer.reset();

    const miss = await requestPasswordReset(null, form({ email: freshEmail() }));

    expect(miss.ok).toBe(true);
    expect(hit.ok).toBe(true);
    // The whole point: the two replies are indistinguishable, so the form is not an account oracle.
    expect(JSON.stringify(miss)).toBe(JSON.stringify(hit));
    if (miss.ok) expect(miss.data.message).toBe(RESET_REQUESTED_MESSAGE);
    expect(mailer.sent).toHaveLength(0);
  });

  it("refuses a malformed address without pretending to have sent anything", async () => {
    const result = await requestPasswordReset(null, form({ email: "not-an-address" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.email).toBeTruthy();
    expect(mailer.sent).toHaveLength(0);
  });

  it("still answers normally when the install has no mailer, and records no attempt", async () => {
    setMailerForTests(null);
    const email = freshEmail();
    const person = await userWithPassword(email);

    const result = await requestPasswordReset(null, form({ email }));

    expect(result.ok).toBe(true);
    expect(await attemptRows(person.id)).toHaveLength(0);
  });

  it("stops at the fourth request for one address inside the window", async () => {
    const email = freshEmail();
    await userWithPassword(email);

    for (let i = 0; i < 3; i++) {
      expect((await requestPasswordReset(null, form({ email }))).ok).toBe(true);
    }
    const fourth = await requestPasswordReset(null, form({ email }));

    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.error).toBe("busy");
    expect(mailer.sent).toHaveLength(3);
  });
});

describe("spending the token", () => {
  /** Requests a reset for a fresh user and returns the token that reached the mailbox. */
  async function requestFor(email: string) {
    const person = await userWithPassword(email);
    await requestPasswordReset(null, form({ email }));
    const token = tokenFromEmail(mailer.sent.at(-1)!.text);
    return { person, token };
  }

  it("sets the new password, retires the old one and sends the person to log in", async () => {
    const email = freshEmail();
    const { token } = await requestFor(email);

    await expect(resetPassword(null, form({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD }))).rejects.toMatchObject(
      new RedirectSignal("/login?reset=1"),
    );

    await expect(signIn(email, NEW_PASSWORD)).resolves.toMatchObject({ user: { email } });
    await expect(signIn(email, OLD_PASSWORD)).rejects.toThrow();
  });

  it("revokes every other session, so a reset actually evicts whoever was signed in", async () => {
    const email = freshEmail();
    const { person, token } = await requestFor(email);
    await createSession(person.id);
    await createSession(person.id);
    expect(await sessionRows(person.id)).toHaveLength(2);

    await expect(resetPassword(null, form({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD }))).rejects.toThrow(
      RedirectSignal,
    );

    expect(await sessionRows(person.id)).toHaveLength(0);
  });

  it("works once: replaying the same link is refused", async () => {
    const email = freshEmail();
    const { token } = await requestFor(email);
    await expect(resetPassword(null, form({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD }))).rejects.toThrow(
      RedirectSignal,
    );

    const replay = await resetPassword(null, form({ token, password: "third-correct-horse-batt", confirm: "third-correct-horse-batt" }));

    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error).toBe("invalid");
    // The password the replay tried to set never took effect.
    await expect(signIn(email, NEW_PASSWORD)).resolves.toMatchObject({ user: { email } });
  });

  it("refuses a token that was never minted", async () => {
    const result = await resetPassword(null, form({ token: "not-a-real-token", password: NEW_PASSWORD, confirm: NEW_PASSWORD }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid");
  });

  it("rejects a short password and a mismatched confirmation before touching the token", async () => {
    const email = freshEmail();
    const { token } = await requestFor(email);

    const short = await resetPassword(null, form({ token, password: "short", confirm: "short" }));
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.fieldErrors?.password).toBeTruthy();

    const mismatch = await resetPassword(null, form({ token, password: NEW_PASSWORD, confirm: `${NEW_PASSWORD}x` }));
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.fieldErrors?.confirm).toBeTruthy();

    // Neither refusal spent the token: it still works.
    await expect(resetPassword(null, form({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD }))).rejects.toThrow(
      RedirectSignal,
    );
  });
});

describe("the link that is actually in the email", () => {
  it("points at Better Auth's callback on this install, carrying Docket's reset page as the destination", async () => {
    const email = freshEmail();
    await userWithPassword(email);
    await requestPasswordReset(null, form({ email }));

    const url = /https?:\S+/.exec(mailer.sent[0]!.text)![0];
    // BETTER_AUTH_URL in the test env; the /api/auth prefix is Better Auth's own basePath.
    expect(url.startsWith("http://localhost:3000/api/auth/reset-password/")).toBe(true);
    expect(new URL(url).searchParams.get("callbackURL")).toBe("/reset-password");
  });

  it("redirects a good token on to the reset page with the token in the query", async () => {
    const email = freshEmail();
    await userWithPassword(email);
    await requestPasswordReset(null, form({ email }));
    const token = tokenFromEmail(mailer.sent[0]!.text);

    // The callback answers with a redirect, which Better Auth raises rather than returns.
    const location = await getAuth()
      .api.requestPasswordResetCallback({
        params: { token },
        query: { callbackURL: "/reset-password" },
        headers: new Headers(),
        asResponse: true,
      })
      .then((res: Response) => res.headers.get("location"))
      .catch((err: unknown) => (err as { headers?: Headers }).headers?.get("location") ?? String(err));

    expect(location).toContain("/reset-password");
    expect(location).toContain(`token=${token}`);
    // It must not bounce the person to the API's own error page.
    expect(location).not.toContain("/api/auth/error");
  });

  it("sends a spent token to the reset page as an error, not as a usable token", async () => {
    const email = freshEmail();
    await userWithPassword(email);
    await requestPasswordReset(null, form({ email }));
    const token = tokenFromEmail(mailer.sent[0]!.text);
    await expect(resetPassword(null, form({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD }))).rejects.toThrow(
      RedirectSignal,
    );

    const location = await getAuth()
      .api.requestPasswordResetCallback({
        params: { token },
        query: { callbackURL: "/reset-password" },
        headers: new Headers(),
        asResponse: true,
      })
      .then((res: Response) => res.headers.get("location"))
      .catch((err: unknown) => (err as { headers?: Headers }).headers?.get("location") ?? String(err));

    expect(location).toContain("error=INVALID_TOKEN");
    expect(location).not.toContain(`token=${token}`);
  });
});
