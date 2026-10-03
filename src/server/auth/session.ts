import { headers } from "next/headers";
import { cache } from "react";
import { getAuth, withBetterAuth } from "./auth";

type Auth = ReturnType<typeof getAuth>;
export type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

/** The current session or null. Cached for the duration of one request. */
export const getSession = cache(async (): Promise<Session | null> => {
  const requestHeaders = await headers();
  return withBetterAuth(() => getAuth().api.getSession({ headers: requestHeaders }));
});

/** The current session, or throws when signed out. Callers redirect to /login on the error. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw new SessionRequiredError();
  return session;
}

export class SessionRequiredError extends Error {
  constructor() {
    super("Sign in required");
    this.name = "SessionRequiredError";
  }
}
