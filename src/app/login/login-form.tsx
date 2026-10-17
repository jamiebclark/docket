"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { safeRedirect } from "@/lib/safe-redirect";
import { buttonStyles } from "@/components/ui/Button";
import { alertStyles } from "@/components/ui/Alert";
import { controlStyles, labelStyles, linkStyles } from "@/components/ui/controls";

const GENERIC_FAILURE = "Email or password is incorrect.";

/**
 * What to show for a failed sign-in.
 *
 * `GENERIC_FAILURE` is deliberately vague about *which* of the two was wrong, but it must only be said
 * when the server actually rejected the credential. Saying it for a request that never arrived is a
 * different kind of lie: on 2026-10-17 a proxy returned 502 for every POST while GETs passed, this form
 * reported "Email or password is incorrect", and that one wrong word sent an hour of debugging after a
 * password bug that did not exist. The password was correct the whole time.
 *
 * Better Auth answers 401 for a bad credential and 429 for the rate limit; anything else — a 5xx, a
 * gateway error, a dropped connection (`status` 0 or absent) — means the password was never checked.
 */
function signInMessage(status: number | undefined): string {
  if (status === 429) return "Too many attempts. Wait a few seconds and try again.";
  if (status === 401 || status === 403) return GENERIC_FAILURE;
  const detail = status ? `HTTP ${status}` : "no response";
  return `Could not reach Docket (${detail}). Your password was not checked — try again, and if it keeps happening the server or the proxy in front of it is refusing requests.`;
}

/** `canReset` is false when this install has no mailer: see the /forgot-password page for why. */
export function LoginForm({ next, canReset }: { next: string; canReset: boolean }) {
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
      setError(signInMessage(failure.status));
      return;
    }
    router.replace(safeRedirect(next, "/"));
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} method="post" className="flex flex-col gap-4" noValidate>
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
      {canReset ? (
        <Link href="/forgot-password" className={`${linkStyles} mt-1 text-center text-sm`}>
          Forgot your password?
        </Link>
      ) : null}
    </form>
  );
}
