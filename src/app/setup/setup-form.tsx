"use client";

import { useActionState } from "react";
import type { ActionResult } from "@/lib/action-result";
import { completeSetup } from "./actions";
import { buttonStyles } from "@/components/ui/Button";
import { alertStyles } from "@/components/ui/Alert";
import { controlStyles } from "@/components/ui/controls";

const input = controlStyles;

export function SetupForm() {
  const [state, action, pending] = useActionState<ActionResult<never> | null, FormData>(completeSetup, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const formError = state && !state.ok && Object.keys(errors).length === 0 ? state.message : null;

  const field = (name: string, label: string, type: string, autoComplete: string, hint?: string) => (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input
        name={name}
        type={type}
        autoComplete={autoComplete}
        required
        aria-invalid={errors[name] ? true : undefined}
        aria-describedby={errors[name] ? `${name}-error` : undefined}
        className={input}
      />
      {hint && !errors[name] ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      {errors[name] ? (
        <span id={`${name}-error`} className="text-xs text-danger">
          {errors[name]}
        </span>
      ) : null}
    </label>
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      {formError ? (
        <p role="alert" className={alertStyles("danger")}>
          {formError}
        </p>
      ) : null}
      {field("name", "Name", "text", "name")}
      {field("email", "Email", "email", "username")}
      {field("password", "Password", "password", "new-password", "12–128 characters")}
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
