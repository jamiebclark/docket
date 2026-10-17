"use client";

import { useActionState, useEffect } from "react";
import Link from "next/link";
import { Alert, alertStyles } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { linkStyles } from "@/components/ui/controls";
import type { ActionResult } from "@/lib/action-result";
import { focusFirstError } from "@/lib/form-focus";
import { requestPasswordReset } from "./actions";

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState<ActionResult<{ message: string }> | null, FormData>(
    requestPasswordReset,
    null,
  );
  const fieldError = state && !state.ok ? state.fieldErrors?.email : undefined;
  const formError = state && !state.ok && !fieldError ? state.message : null;

  // The result arrives after the action resolves, so the focus move belongs in an effect, not the handler.
  useEffect(() => {
    if (fieldError) focusFirstError({ email: fieldError }, ["email"]);
  }, [fieldError, state]);

  // On success the form is replaced rather than reset: leaving an email box under a "check your inbox"
  // message invites a second, third and fourth submission straight into the rate limit.
  if (state?.ok) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="success">{state.data.message}</Alert>
        <p className="text-sm text-muted-foreground">
          Nothing arrived? Check the spam folder, then{" "}
          <Link href="/forgot-password" className={linkStyles}>
            ask for another link
          </Link>
          .
        </p>
        <Link href="/login" className={linkStyles}>
          Back to log in
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-2" noValidate>
      {formError ? (
        <p role="alert" className={alertStyles("danger")}>
          {formError}
        </p>
      ) : null}
      <Field
        id="email"
        name="email"
        label="Email"
        type="email"
        autoComplete="username"
        required
        autoFocus
        error={fieldError}
      />
      <Button type="submit" pending={pending} pendingLabel="Sending…">
        Email me a reset link
      </Button>
      <Link href="/login" className={`${linkStyles} mt-2 text-sm`}>
        Back to log in
      </Link>
    </form>
  );
}
