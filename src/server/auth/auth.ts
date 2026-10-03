import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins/organization";
import { getEnv } from "../env";
import { getDb } from "../db/client";
import { runCrossProject } from "../db/cross-project";
import * as schema from "../db/schema";
import { createEmailAttemptLimiter } from "./sign-in-limit";
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
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
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
