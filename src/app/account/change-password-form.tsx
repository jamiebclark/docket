"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { authClient } from "@/lib/auth-client";
import { focusFirstError } from "@/lib/form-focus";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/validation/password";

const FIELD_ORDER = ["current", "password", "confirm"] as const;

type Errors = { password?: string; confirm?: string; current?: string };

/**
 * Goes over HTTP through `authClient`, like the sign-in form and for the same reason: with
 * `revokeOtherSessions` Better Auth deletes every session for the account — the current one included —
 * mints a replacement and sets its cookie on the response. Only the `/api/auth` route runs the
 * `nextCookies()` plugin that writes that cookie back, so an in-process server action would change the
 * password and then sign the person out of the browser they changed it in.
 */
export function ChangePasswordForm() {
  const router = useRouter();
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const current = String(data.get("current") ?? "");
    const password = String(data.get("password") ?? "");
    const confirm = String(data.get("confirm") ?? "");

    setErrors({});
    setFormError(null);
    setDone(false);

    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      const next = { password: `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters` };
      setErrors(next);
      focusFirstError(next, FIELD_ORDER);
      return;
    }
    if (password !== confirm) {
      const next = { confirm: "Those passwords do not match." };
      setErrors(next);
      focusFirstError(next, FIELD_ORDER);
      return;
    }

    setPending(true);
    const { error } = await authClient.changePassword({
      currentPassword: current,
      newPassword: password,
      revokeOtherSessions: true,
    });
    setPending(false);

    if (error) {
      if (error.status === 429) {
        setFormError("Too many attempts. Wait a few seconds and try again.");
      } else if (error.status === 400) {
        // The only 400 this form can provoke is a wrong current password: the lengths are checked above.
        const next = { current: "That is not your current password." };
        setErrors(next);
        focusFirstError(next, FIELD_ORDER);
      } else {
        setFormError("Could not change your password. Try again.");
      }
      return;
    }

    form.reset();
    setDone(true);
    // The session cookie was just rotated; refresh so the server sees the new one straight away.
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-md flex-col gap-2" noValidate>
      {done ? <Alert tone="success">Your password has been changed. Other devices have been signed out.</Alert> : null}
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <Field
        id="current"
        name="current"
        label="Current password"
        type="password"
        autoComplete="current-password"
        required
        error={errors.current}
      />
      <Field
        id="password"
        name="password"
        label="New password"
        type="password"
        autoComplete="new-password"
        required
        hint={`${PASSWORD_MIN}–${PASSWORD_MAX} characters`}
        error={errors.password}
      />
      <Field
        id="confirm"
        name="confirm"
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        required
        error={errors.confirm}
      />
      <Button type="submit" pending={pending} pendingLabel="Saving…" className="mt-2 self-start">
        Change password
      </Button>
    </form>
  );
}
