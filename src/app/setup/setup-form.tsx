"use client";

import { useActionState } from "react";
import type { ActionResult } from "@/lib/action-result";
import { completeSetup } from "./actions";
import { buttonStyles } from "@/components/ui/Button";
import { alertStyles } from "@/components/ui/Alert";
import { controlStyles } from "@/components/ui/controls";

const input = controlStyles;

export function SetupField({
  name,
  label,
  type,
  autoComplete,
  hint,
  error,
}: {
  name: string;
  label: string;
  type: string;
  autoComplete: string;
  hint?: string;
  error?: string;
}) {
  const describedBy = [hint ? `${name}-hint` : null, error ? `${name}-error` : null].filter(Boolean).join(" ");
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input
        name={name}
        type={type}
        autoComplete={autoComplete}
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={input}
      />
      {hint ? (
        <span id={`${name}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${name}-error`} className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function SetupForm() {
  const [state, action, pending] = useActionState<ActionResult<never> | null, FormData>(completeSetup, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const formError = state && !state.ok && Object.keys(errors).length === 0 ? state.message : null;

  return (
    <form action={action} className="flex flex-col gap-4">
      {formError ? (
        <p role="alert" className={alertStyles("danger")}>
          {formError}
        </p>
      ) : null}
      <SetupField name="name" label="Name" type="text" autoComplete="name" error={errors.name} />
      <SetupField name="email" label="Email" type="email" autoComplete="username" error={errors.email} />
      <SetupField name="password" label="Password" type="password" autoComplete="new-password" hint="12–128 characters" error={errors.password} />
      <button
        type="submit"
        disabled={pending}
        className={buttonStyles({ variant: "primary" })}
      >
        {pending ? "Creating…" : "Create account"}
      </button>
    </form>
  );
}
