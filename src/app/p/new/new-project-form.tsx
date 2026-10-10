"use client";

import { useActionState, useEffect, useState } from "react";
import type { ActionResult } from "@/lib/action-result";
import { SLUG_MAX } from "@/lib/validation/slug";
import { createProject } from "./actions";
import { buttonStyles } from "@/components/ui/Button";
import { alertStyles } from "@/components/ui/Alert";
import { Field } from "@/components/ui/Field";
import { TimeZoneField } from "@/components/ui/TimeZoneField";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
}

export function NewProjectForm() {
  const [state, action, pending] = useActionState<ActionResult<never> | null, FormData>(createProject, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const formError = state && !state.ok && Object.keys(errors).length === 0 ? state.message : null;
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [timezone, setTimezone] = useState("UTC");

  // The browser knows the user's time zone; the server can't.
  useEffect(() => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // A browser-only value, so it can only be read after hydration; runs once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (local) setTimezone((tz) => (tz === "UTC" ? local : tz));
  }, []);

  return (
    <form action={action} className="flex flex-col gap-4">
      {formError ? (
        <p role="alert" className={alertStyles("danger")}>
          {formError}
        </p>
      ) : null}
      <Field
        id="name"
        name="name"
        label="Name"
        required
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          if (!slugEdited) setSlug(slugify(e.target.value));
        }}
        error={errors.name}
      />
      <Field
        id="slug"
        name="slug"
        label="URL name"
        hint="Lowercase letters, numbers and hyphens"
        required
        value={slug}
        onChange={(e) => {
          setSlugEdited(true);
          setSlug(e.target.value);
        }}
        error={errors.slug}
      />
      <TimeZoneField id="timezone" hint="Posting times and the calendar use this zone." name="timezone" defaultValue="UTC" value={timezone} onChange={setTimezone} error={errors.timezone} />
      <button
        type="submit"
        disabled={pending}
        className={buttonStyles({ variant: "primary", className: "self-start" })}
      >
        {pending ? "Creating…" : "Create project"}
      </button>
    </form>
  );
}
