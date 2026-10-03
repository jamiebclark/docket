"use client";

import { useActionState } from "react";
import type { ActionResult } from "@/lib/action-result";
import { completeSetup } from "./actions";

const input = "rounded border border-foreground/30 bg-transparent px-3 py-2 focus-visible:ring-2";

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
      {hint && !errors[name] ? <span className="text-xs opacity-70">{hint}</span> : null}
      {errors[name] ? (
        <span id={`${name}-error`} className="text-xs text-red-700 dark:text-red-400">
          {errors[name]}
        </span>
      ) : null}
    </label>
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      {formError ? (
        <p role="alert" className="rounded border border-red-600 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {formError}
        </p>
      ) : null}
      {field("name", "Name", "text", "name")}
      {field("email", "Email", "email", "username")}
      {field("password", "Password", "password", "new-password", "12–128 characters")}
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-foreground px-3 py-2 text-background disabled:opacity-60 focus-visible:ring-2"
      >
        {pending ? "Creating…" : "Create account"}
      </button>
    </form>
  );
}
