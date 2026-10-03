"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { ActionResult } from "@/lib/action-result";
import { createProject } from "./actions";

const input = "rounded border border-foreground/30 bg-transparent px-3 py-2 focus-visible:ring-2";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function NewProjectForm() {
  const [state, action, pending] = useActionState<ActionResult<never> | null, FormData>(createProject, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const formError = state && !state.ok && Object.keys(errors).length === 0 ? state.message : null;
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const timezoneRef = useRef<HTMLInputElement>(null);

  // The browser knows the user's time zone; the server can't.
  useEffect(() => {
    const input = timezoneRef.current;
    if (input && input.value === "UTC") input.value = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }, []);

  const err = (name: string) =>
    errors[name] ? (
      <span id={`${name}-error`} className="text-xs text-red-700 dark:text-red-400">
        {errors[name]}
      </span>
    ) : null;
  const a11y = (n: string) => ({
    "aria-invalid": errors[n] ? true : undefined,
    "aria-describedby": errors[n] ? `${n}-error` : undefined,
  });

  return (
    <form action={action} className="flex flex-col gap-4">
      {formError ? (
        <p role="alert" className="rounded border border-red-600 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {formError}
        </p>
      ) : null}
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input
          name="name"
          required
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugEdited) setSlug(slugify(e.target.value));
          }}
          className={input}
          {...a11y("name")}
        />
        {err("name")}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        URL name
        <input
          name="slug"
          required
          value={slug}
          onChange={(e) => {
            setSlugEdited(true);
            setSlug(e.target.value);
          }}
          className={input}
          {...a11y("slug")}
        />
        {errors.slug ? err("slug") : <span className="text-xs opacity-70">Lowercase letters, numbers and hyphens</span>}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Time zone
        <input
          name="timezone"
          required
          ref={timezoneRef}
          defaultValue="UTC"
          className={input}
          {...a11y("timezone")}
        />
        {errors.timezone ? err("timezone") : <span className="text-xs opacity-70">IANA name, e.g. America/New_York</span>}
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-foreground px-3 py-2 text-background disabled:opacity-60 focus-visible:ring-2"
      >
        {pending ? "Creating…" : "Create project"}
      </button>
    </form>
  );
}
