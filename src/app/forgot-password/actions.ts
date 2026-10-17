"use server";

import { headers } from "next/headers";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { RESET_REQUESTED_MESSAGE } from "@/lib/auth-text";
import { emailSchema } from "@/lib/validation/email";
import { isAPIError } from "better-auth/api";
import { getAuth, RESET_PASSWORD_PATH } from "@/server/auth/auth";

/**
 * Asks Better Auth to mint and email a reset token. Better Auth owns the whole token lifecycle — the
 * constant-time miss for an unknown address, the single-use row in `verification`, the expiry — so this
 * action only validates the field and translates the one outcome worth distinguishing (a rate limit).
 */
export async function requestPasswordReset(
  _prev: ActionResult<{ message: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ message: string }>> {
  const parsed = emailSchema.safeParse(String(formData.get("email") ?? ""));
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Enter a valid email address";
    return fail("validation", message, { email: message });
  }

  try {
    await getAuth().api.requestPasswordReset({
      body: { email: parsed.data, redirectTo: RESET_PASSWORD_PATH },
      headers: await headers(),
    });
  } catch (error) {
    // Better Auth's APIError carries the name in `status` ("TOO_MANY_REQUESTS") and the number in
    // `statusCode`. A rate limit is worth showing, because the person can act on it by waiting;
    // everything else collapses into the neutral success below, so a transport or database failure
    // never reads differently from an address with no account.
    if (isAPIError(error) && error.statusCode === 429) {
      return fail("busy", "Too many reset requests for that address. Wait a minute and try again.");
    }
    // Silent to the caller, never silent to the operator. The reply has to be identical whether or not
    // the address exists, but swallowing the reason entirely means a genuinely broken reset looks
    // exactly like a working one — which is how a production failure went unexplained on 2026-10-17.
    // The status and error name only; never the address, and never the token.
    console.error(
      `Docket auth: password reset request failed (${isAPIError(error) ? `status ${error.statusCode}` : (error as Error)?.name || "unknown"})`,
    );
  }

  return ok({ message: RESET_REQUESTED_MESSAGE });
}
