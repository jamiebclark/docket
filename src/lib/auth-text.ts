/**
 * User-facing copy for the sign-in and password-reset screens, kept out of the server-action modules:
 * every export of a `"use server"` file must be an async Server Function, so a plain string constant
 * cannot live beside the action that returns it.
 */

/**
 * The one sentence `/forgot-password` ever says on success. Deliberately identical whether the address
 * has an account, has none, or had one whose send failed — anything that varied would turn the form
 * into a test for "is this person a Docket user?".
 */
export const RESET_REQUESTED_MESSAGE =
  "If that address has a Docket account, a link to choose a new password is on its way. The link lasts an hour.";
