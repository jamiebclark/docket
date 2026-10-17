import { XRPCError } from "@atproto/api";
import type { ConnectResult, RefreshResult } from "../types";
import { agentFor } from "./client";
import { errorName, isDefinitiveRefusal, rateLimitNotBefore } from "./errors";
import { blueskyCredentialsSchema, normaliseHandle, normalisePdsUrl, type BlueskyCredentials, type BlueskySettings } from "./settings";

const SIXTY_DAYS_MS = 60 * 86_400_000;
const REFRESH_AHEAD_MS = 5 * 60_000;

/** The `exp` claim of a JWT as a Date, without verifying it. `null` when it cannot be read. */
export function jwtExp(jwt: string): Date | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? new Date(exp * 1000) : null;
  } catch {
    return null;
  }
}

/** True when the access token expires within five minutes. Unknown expiry or unreadable credentials → false. */
export function needsRefresh(credentials: unknown, now: Date): boolean {
  const parsed = blueskyCredentialsSchema.safeParse(credentials);
  if (!parsed.success) return false;
  const exp = jwtExp(parsed.data.accessJwt);
  return exp !== null && exp.getTime() - now.getTime() < REFRESH_AHEAD_MS;
}

const fail = (message: string, field?: string, retryAt?: Date): ConnectResult => ({
  ok: false,
  message,
  ...(field ? { field } : {}),
  ...(retryAt ? { retryAt } : {}),
});

export async function connectAccount(input: {
  fields: Readonly<Record<string, string>>;
  now: Date;
  signal: AbortSignal;
}): Promise<ConnectResult> {
  const handle = normaliseHandle(input.fields.handle ?? "");
  if (handle === "" || /\s/.test(handle)) return fail("Enter your Bluesky handle, for example you.bsky.social.", "handle");
  const pdsUrl = normalisePdsUrl(input.fields.pdsUrl);
  if (pdsUrl === null) return fail("Enter an https:// address with no path, for example https://bsky.social.", "pdsUrl");

  // Trimmed like the handle: an app password pasted from Bluesky's settings often carries a
  // trailing newline or space, and the PDS answers 401, which reads as a wrong password.
  const appPassword = (input.fields.appPassword ?? "").trim();
  try {
    const res = await agentFor(pdsUrl).com.atproto.server.createSession({ identifier: handle, password: appPassword }, { signal: input.signal });
    const { accessJwt, refreshJwt, did, handle: returned } = res.data;
    return {
      ok: true,
      account: {
        externalId: did,
        displayName: returned,
        settings: { pdsUrl } satisfies BlueskySettings,
        credentials: { accessJwt, refreshJwt, did, handle: returned, appPassword },
        expiresAt: jwtExp(refreshJwt) ?? new Date(input.now.getTime() + SIXTY_DAYS_MS),
      },
    };
  } catch (err) {
    if (err instanceof XRPCError) {
      if (err.error === "AuthFactorTokenRequired") {
        return fail("This account needs a sign-in code. Use an app password instead of your main password.", "appPassword");
      }
      if (err.error === "AccountTakedown") return fail("This Bluesky account is suspended.");
      if (err.status === 429) {
        return fail("Too many sign-in attempts. Try again later.", undefined, rateLimitNotBefore(err.headers, input.now) ?? undefined);
      }
      // A PDS rejects bad credentials with 401 (AuthRequiredError). Other 4xx come from hosts
      // that do not implement createSession — e.g. an HTML 404 (XRPCNotSupported) or an
      // empty 405 the client reports as 400 — so blame the address, not the password (F1).
      if (err.status === 401) {
        return fail("Bluesky did not accept that handle or app password.", "appPassword");
      }
      // 400 InvalidRequest is ambiguous: a PDS refusing a malformed handle, or a non-PDS host
      // answering an empty 405. Name every place to look rather than guess.
      if (err.status === 400) {
        return fail("Bluesky rejected the sign-in. Check the handle, the app password and the server address.");
      }
      if (err.status >= 400 && err.status < 500) {
        return fail(`${pdsUrl} did not answer as a Bluesky server (PDS). Check the address.`, "pdsUrl");
      }
    }
    return fail(`Could not reach a Bluesky server at ${pdsUrl}. Check the address and try again.`, "pdsUrl");
  }
}

/**
 * Opens a brand-new session from the stored app password after a refusal. Identifies by DID, not
 * handle, so an account that was renamed still signs in. `null` means the password no longer works
 * either, and the caller reports the original refusal so a human reconnects.
 */
async function reauthenticate(input: {
  creds: BlueskyCredentials;
  settings: BlueskySettings;
  now: Date;
  signal: AbortSignal;
}): Promise<Extract<RefreshResult, { ok: true }> | null> {
  const { creds } = input;
  if (!creds.appPassword) return null;
  try {
    const res = await agentFor(input.settings.pdsUrl).com.atproto.server.createSession(
      { identifier: creds.did, password: creds.appPassword },
      { signal: input.signal },
    );
    if (res.data.did !== creds.did) return null;
    return {
      ok: true,
      credentials: {
        accessJwt: res.data.accessJwt,
        refreshJwt: res.data.refreshJwt,
        did: creds.did,
        handle: res.data.handle ?? creds.handle,
        appPassword: creds.appPassword,
      },
      expiresAt: jwtExp(res.data.refreshJwt) ?? new Date(input.now.getTime() + SIXTY_DAYS_MS),
      displayName: res.data.handle ?? creds.handle,
    };
  } catch {
    // Includes a network blip, which costs nothing extra: the refresh was already refused for
    // good, so without this the account was being flagged for a human regardless.
    return null;
  }
}

export async function refreshCredentials(input: {
  account: { id: string; externalId: string; settings: BlueskySettings };
  credentials: unknown;
  now: Date;
  signal: AbortSignal;
}): Promise<RefreshResult> {
  const parsed = blueskyCredentialsSchema.safeParse(input.credentials);
  if (!parsed.success) return { ok: false, reason: "Stored credentials are unreadable." };
  const creds = parsed.data;
  try {
    const res = await agentFor(input.account.settings.pdsUrl).com.atproto.server.refreshSession(undefined, {
      headers: { authorization: `Bearer ${creds.refreshJwt}` },
      signal: input.signal,
    });
    if (res.data.did !== creds.did) return { ok: false, reason: "The server returned a different account." };
    return {
      ok: true,
      credentials: {
        accessJwt: res.data.accessJwt,
        refreshJwt: res.data.refreshJwt,
        did: creds.did,
        handle: res.data.handle ?? creds.handle,
        // Carried forward, or the first refresh would drop it and re-authentication would be
        // impossible from then on.
        ...(creds.appPassword ? { appPassword: creds.appPassword } : {}),
      },
      expiresAt: jwtExp(res.data.refreshJwt) ?? new Date(input.now.getTime() + SIXTY_DAYS_MS),
      displayName: res.data.handle,
    };
  } catch (err) {
    if (isDefinitiveRefusal(err)) {
      // The refresh token is dead for good, but a stored app password can open a fresh session,
      // which is the whole point of keeping one: no missed posts waiting on a human.
      if (creds.appPassword) {
        const reauthed = await reauthenticate({ creds, settings: input.account.settings, now: input.now, signal: input.signal });
        if (reauthed) return reauthed;
      }
      return { ok: false, reason: `Bluesky refused to renew the session (${errorName(err)}). Reconnect the account with an app password.` };
    }
    const retryAt = err instanceof XRPCError ? rateLimitNotBefore(err.headers, input.now) : null;
    return {
      ok: false,
      transient: true,
      reason: `Could not renew the Bluesky session (${err instanceof XRPCError && err.status > 2 ? err.status : "no response"}).`,
      ...(retryAt ? { retryAt } : {}),
    };
  }
}
