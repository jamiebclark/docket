import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { after } from "next/server";
import { organization } from "better-auth/plugins/organization";
import { getEnv } from "../env";
import { getDb } from "../db/client";
import { runCrossProject } from "../db/cross-project";
import * as schema from "../db/schema";
import { sendPasswordResetEmail } from "../services/password-reset";
import { createEmailAttemptLimiter, createGlobalAttemptLimiter } from "./sign-in-limit";
import { ac, roles } from "./access";

/**
 * Over HTTP, sign-up needs an invitation (Docket's own services call the API in-process) and
 * Better Auth's organization endpoints do not exist: Docket owns every membership change.
 * In-process calls have no `request`, so they pass.
 */
export function gateBlockedPaths(path: string, hasRequest: boolean): { status: 400 | 404; message: string } | null {
  if (!hasRequest) return null;
  if (path === "/sign-up/email") return { status: 400, message: "Sign-up requires an invitation" };
  if (path.startsWith("/organization/")) return { status: 404, message: "Not found" };
  return null;
}

/** Per-email sign-in limit, keyed on the submitted email so a forged client IP cannot sidestep it. */
const signInLimiter = createEmailAttemptLimiter({ max: 3, windowMs: 10_000 });

/**
 * Per-email reset-request limit, matching Better Auth's own window for the route (3 per 60s) but keyed
 * on the submitted address rather than the client IP. This one is NOT gated on `ctx.request`: unlike
 * sign-in, the reset request also arrives in-process from the /forgot-password server action, and that
 * path never passes through the HTTP rate limiter, so the hook is the only choke point both share.
 *
 * The key is the submitted email whether or not an account exists, so a 429 says nothing about which
 * addresses are real — the endpoint's whole design is to be silent on that (FR: no enumeration).
 */
const resetRequestLimiter = createEmailAttemptLimiter({ max: 3, windowMs: 60_000 });

/**
 * Process-wide ceiling on reset requests, independent of address. The per-email limiter above stops one
 * address being mailed repeatedly; this stops one caller walking a list of addresses and having Docket
 * mail every real one. 60 a minute is far above any genuine use of a Docket install.
 */
const resetRequestCeiling = createGlobalAttemptLimiter({ max: 60, windowMs: 60_000 });

/**
 * How long an emailed reset link stays good. One hour is Better Auth's own default; it is stated here
 * because the figure is quoted to the person in the email body, so the two must not drift.
 */
export const RESET_PASSWORD_TTL_SECONDS = 3600;

/** Where Better Auth's token callback sends the person once the link checks out: Docket's own page. */
export const RESET_PASSWORD_PATH = "/reset-password";

function createAuth() {
  const env = getEnv();
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        organization: schema.organization,
        member: schema.member,
        invitation: schema.invitation,
      },
      transaction: true,
    }),
    advanced: {
      database: { generateId: "uuid" },
      // Unset keeps Better Auth's default (x-forwarded-for). See README "Sessions and rate limits".
      ipAddress: {
        ...(env.TRUSTED_IP_HEADERS ? { ipAddressHeaders: env.TRUSTED_IP_HEADERS } : {}),
        ...(env.TRUSTED_PROXIES ? { trustedProxies: env.TRUSTED_PROXIES } : {}),
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: RESET_PASSWORD_TTL_SECONDS,
      // A reset is a credential handover to whoever holds the mailbox, so every other session for that
      // account goes with it: if the reason for the reset was that somebody else was signed in, leaving
      // their session alive would defeat the whole exercise.
      revokeSessionsOnPasswordReset: true,
      /**
       * Better Auth has already found the user and minted the single-use token by the time this runs;
       * all that is left is the message. It must not throw: the endpoint deliberately answers the same
       * way whether or not the address exists, and an exception here would make a failed send
       * distinguishable from a successful one and so leak which addresses are real.
       */
      sendResetPassword: async ({ user, url }) => {
        const deliver = async () => {
          try {
            const outcome = await sendPasswordResetEmail({
              user: { id: user.id, name: user.name, email: user.email },
              resetUrl: url,
              expiresAt: new Date(Date.now() + RESET_PASSWORD_TTL_SECONDS * 1000),
            });
            // Deferred past the response, so this line is the only place an operator can see that a
            // reset was asked for and what became of it. `unavailable` means no SMTP group is
            // configured; `failed` means the server refused or could not be reached. Never the address.
            if (outcome !== "sent") console.error(`Docket auth: password reset email ${outcome}`);
          } catch (error) {
            // `sendPasswordResetEmail` promises not to throw and records its own attempt row, so this
            // is Docket's own fault rather than the mail server's. Name it; it is invisible otherwise.
            console.error(`Docket auth: password reset delivery threw (${(error as Error)?.name || "unknown"})`);
          }
        };

        // The send MUST NOT block the reply. Better Auth awaits this inline unless
        // `advanced.backgroundTasks.handler` is set (`runInBackgroundOrAwait` in its
        // context/create-context), and an SMTP conversation is allowed 10s to connect, 10s to greet
        // and 20s on the socket (src/server/mail/smtp.ts). Blocking on that is wrong twice over:
        //
        // 1. A mail host that does not answer takes the page down rather than failing quietly. With
        //    `SMTP_PORT`/`SMTP_SECURITY` unset the transport connects plaintext on 587, so a provider
        //    wanting implicit TLS on 465 hangs for the full timeout — observed in production as a
        //    Cloudflare 502 on /forgot-password.
        // 2. It leaks whether the address has an account. An unknown address returns at once; a known
        //    one waits for SMTP. That timing difference is an enumeration oracle, which undoes the
        //    constant-time miss Better Auth goes to the trouble of providing.
        //
        // `after()` runs the work once the response is sent. Outside a request — in-process callers,
        // tests, scripts — there is no response to defer past, so it throws and we await instead,
        // which also keeps the integration tests deterministic.
        try {
          after(deliver);
        } catch {
          await deliver();
        }
      },
    },
    rateLimit: {
      enabled: true,
      // The per-email limit below is the sign-in guard; the per-IP rule is only a loose backstop
      // against one client trying many emails, because the IP can be client-chosen.
      customRules: { "/sign-in/email": { window: 10, max: 30 } },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.request && ctx.path === "/sign-in/email") {
          const email = (ctx.body as { email?: unknown } | undefined)?.email;
          if (typeof email === "string" && !signInLimiter.attempt(email)) {
            throw new APIError("TOO_MANY_REQUESTS", { message: "Too many requests. Please try again later." });
          }
        }
        // No `ctx.request` guard: /forgot-password calls this endpoint in-process, where the HTTP rate
        // limiter never runs, so this hook is the only limit both routes into it share.
        if (ctx.path === "/request-password-reset") {
          const email = (ctx.body as { email?: unknown } | undefined)?.email;
          const tooMany = typeof email === "string" && !resetRequestLimiter.attempt(email);
          // The ceiling is consumed on every request, including one the per-email limit already refused,
          // so retry storms against many addresses cannot wash through it.
          if (!resetRequestCeiling.attempt() || tooMany) {
            throw new APIError("TOO_MANY_REQUESTS", { message: "Too many requests. Please try again later." });
          }
        }
        const blocked = gateBlockedPaths(ctx.path, Boolean(ctx.request));
        if (!blocked) return;
        throw new APIError(blocked.status === 400 ? "BAD_REQUEST" : "NOT_FOUND", {
          message: blocked.message,
        });
      }),
    },
    plugins: [
      organization({
        ac,
        roles,
        creatorRole: "owner",
        invitationExpiresIn: env.INVITATION_TTL_DAYS * 86400,
      }),
      nextCookies(), // last (research U2)
    ],
  });
}

type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

/** Lazy so importing this module at build time needs no secrets. */
export function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}

/** Better Auth reads `user`/`session`/`member` itself, so its queries are not project-pinned. */
export function withBetterAuth<T>(fn: () => Promise<T>): Promise<T> {
  return runCrossProject("better-auth", fn);
}
