"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAPIError } from "better-auth/api";
import { fail, type ActionResult } from "@/lib/action-result";
import { passwordSchema } from "@/lib/validation/password";
import { getAuth } from "@/server/auth/auth";

/**
 * Consumes the emailed token and sets the new password. Better Auth owns the token: it is single-use,
 * so a replay of the same link fails here rather than silently setting the password twice, and
 * `revokeSessionsOnPasswordReset` clears every other session as a side effect.
 *
 * Returns only on failure — success redirects to the sign-in page, because the reset deliberately does
 * not sign the person in. Holding a mailbox proves the address, and whoever just picked the password
 * should have to type it once to confirm they know it.
 */
export async function resetPassword(
  _prev: ActionResult<never> | null,
  formData: FormData,
): Promise<ActionResult<never>> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!token) return fail("invalid", "This reset link is missing its token. Ask for a new link.");

  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Choose a longer password";
    return fail("validation", message, { password: message });
  }
  if (password !== confirm) {
    return fail("validation", "Those passwords do not match.", { confirm: "Those passwords do not match." });
  }

  try {
    await getAuth().api.resetPassword({ body: { newPassword: parsed.data, token }, headers: await headers() });
  } catch (error) {
    if (isAPIError(error) && error.statusCode === 429) {
      return fail("busy", "Too many attempts. Wait a minute and try again.");
    }
    // Only a 400 from this endpoint is actually about the token: expired, already spent, or never
    // valid. Reporting anything else as a spent link is a lie that costs the person their next step —
    // they ask for a new link, which is exactly what will not help. Worse, Better Auth consumes the
    // token before it writes the password, so a failure after that point leaves the token spent and
    // the password possibly already changed; telling them to request another link sends them round a
    // loop that burns a token each time. Observed on 2026-10-17, where the real cause was a proxy
    // returning 502 for every POST and nothing was wrong with the token at all.
    if (isAPIError(error) && error.statusCode === 400) {
      return fail("invalid", "This reset link has expired or has already been used. Ask for a new one.");
    }
    return fail(
      "conflict",
      "Something went wrong while setting your password, and it may or may not have been changed. Try signing in with the new password first — only ask for another link if that fails.",
    );
  }

  redirect("/login?reset=1");
}
