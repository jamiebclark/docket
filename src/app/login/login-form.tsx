"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { safeRedirect } from "@/lib/safe-redirect";
import { buttonStyles } from "@/components/ui/Button";
import { alertStyles } from "@/components/ui/Alert";
import { controlStyles, labelStyles } from "@/components/ui/controls";

const GENERIC_FAILURE = "Email or password is incorrect.";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error: failure } = await authClient.signIn.email({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    if (failure) {
      setPending(false);
      setError(failure.status === 429 ? "Too many attempts. Wait a few seconds and try again." : GENERIC_FAILURE);
      return;
    }
    router.replace(safeRedirect(next, "/"));
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {error ? (
        <p role="alert" className={alertStyles("danger")}>
          {error}
        </p>
      ) : null}
      <label className={`flex flex-col gap-1.5 ${labelStyles}`}>
        Email
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          className={`${controlStyles} h-10 font-normal`}
        />
      </label>
      <label className={`flex flex-col gap-1.5 ${labelStyles}`}>
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={`${controlStyles} h-10 font-normal`}
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className={buttonStyles({ variant: "primary", size: "lg", className: "mt-2 w-full" })}
      >
        {pending ? "Logging in…" : "Log in"}
      </button>
    </form>
  );
}
