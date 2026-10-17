"use client";

import { useActionState, useEffect } from "react";
import Link from "next/link";
import { alertStyles } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { linkStyles } from "@/components/ui/controls";
import type { ActionResult } from "@/lib/action-result";
import { focusFirstError } from "@/lib/form-focus";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/validation/password";
import { resetPassword } from "./actions";

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<ActionResult<never> | null, FormData>(resetPassword, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const formError = state && !state.ok && Object.keys(errors).length === 0 ? state.message : null;
  // An expired or spent token cannot be fixed by retyping the password, so the form gives way to the
  // one action that helps: ask for a fresh link.
  const deadLink = state && !state.ok && state.error === "invalid";

  useEffect(() => {
    if (!deadLink) focusFirstError(errors, ["password", "confirm"]);
  }, [errors, deadLink, state]);

  if (deadLink) {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert" className={alertStyles("danger")}>
          {state.message}
        </p>
        <Link href="/forgot-password" className={linkStyles}>
          Ask for a new reset link
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-2" noValidate>
      <input type="hidden" name="token" value={token} />
      {formError ? (
        <p role="alert" className={alertStyles("danger")}>
          {formError}
        </p>
      ) : null}
      <Field
        id="password"
        name="password"
        label="New password"
        type="password"
        autoComplete="new-password"
        required
        autoFocus
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
      <Button type="submit" pending={pending} pendingLabel="Saving…">
        Set new password
      </Button>
    </form>
  );
}
