"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import type { ActionResult } from "@/lib/action-result";
import { signUpWithInvitation } from "./actions";
import { alertStyles } from "@/components/ui/Alert";

export function SignupForm({ token, email }: { token: string; email: string }) {
  const [state, action, pending] = useActionState<ActionResult<never> | null, FormData>(signUpWithInvitation, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const formError = state && !state.ok && Object.keys(errors).length === 0 ? state.message : null;

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="token" value={token} />
      {formError ? (
        <p role="alert" className={alertStyles("danger")}>
          {formError}
        </p>
      ) : null}
      <Field id="email" label="Email" type="email" value={email} readOnly autoComplete="username" hint="Set by the invitation" />
      <Field id="name" name="name" label="Name" autoComplete="name" required error={errors.name} />
      <Field id="password" name="password" label="Password" type="password" autoComplete="new-password" required hint="12–128 characters" error={errors.password} />
      <Button type="submit" pending={pending} pendingLabel="Creating account…">
        Create account and join
      </Button>
    </form>
  );
}
