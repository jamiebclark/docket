"use client";

import { useActionState } from "react";
import type { ActionResult } from "@/lib/action-result";
import { updateProjectSettings } from "./actions";

const input =
  "rounded border border-foreground/30 bg-transparent px-3 py-2 focus-visible:ring-2 disabled:opacity-60";

export interface SettingsValues {
  name: string;
  slug: string;
  timezone: string;
  defaultApprovalPolicy: "review_required" | "auto_approve";
  defaultSchedulingPolicy: "leave_as_draft" | "add_to_queue";
}

export function SettingsForm({ values, canEdit }: { values: SettingsValues; canEdit: boolean }) {
  const [state, action, pending] = useActionState<ActionResult<{ saved: true }> | null, FormData>(
    updateProjectSettings,
    null,
  );
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const formError = state && !state.ok && Object.keys(errors).length === 0 ? state.message : null;
  const err = (n: string) =>
    errors[n] ? (
      <span id={`${n}-error`} className="text-xs text-red-700 dark:text-red-400">
        {errors[n]}
      </span>
    ) : null;
  const a11y = (n: string) => ({
    "aria-invalid": errors[n] ? true : undefined,
    "aria-describedby": errors[n] ? `${n}-error` : undefined,
  });

  return (
    <form action={action} className="flex max-w-xl flex-col gap-4">
      <input type="hidden" name="currentSlug" value={values.slug} />
      {!canEdit ? (
        <p className="rounded border border-foreground/30 px-3 py-2 text-sm">
          Only owners and admins can change project settings.
        </p>
      ) : null}
      {formError ? (
        <p role="alert" className="rounded border border-red-600 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {formError}
        </p>
      ) : null}
      {state?.ok ? (
        <p role="status" className="rounded border border-foreground/30 px-3 py-2 text-sm">
          Settings saved.
        </p>
      ) : null}
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input name="name" required defaultValue={values.name} disabled={!canEdit} className={input} {...a11y("name")} />
        {err("name")}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        URL name
        <input name="slug" required defaultValue={values.slug} disabled={!canEdit} className={input} {...a11y("slug")} />
        {errors.slug ? err("slug") : <span className="text-xs opacity-70">Changing this moves the project to a new URL</span>}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Time zone
        <input
          name="timezone"
          required
          defaultValue={values.timezone}
          disabled={!canEdit}
          className={input}
          {...a11y("timezone")}
        />
        {errors.timezone ? err("timezone") : <span className="text-xs opacity-70">IANA name, e.g. America/New_York</span>}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Default approval
        <select
          name="defaultApprovalPolicy"
          defaultValue={values.defaultApprovalPolicy}
          disabled={!canEdit}
          className={input}
          {...a11y("defaultApprovalPolicy")}
        >
          <option value="review_required">Review required</option>
          <option value="auto_approve">Auto-approve: generated posts skip review</option>
        </select>
        {err("defaultApprovalPolicy")}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Default scheduling
        <select
          name="defaultSchedulingPolicy"
          defaultValue={values.defaultSchedulingPolicy}
          disabled={!canEdit}
          className={input}
          {...a11y("defaultSchedulingPolicy")}
        >
          <option value="leave_as_draft">Leave as draft</option>
          <option value="add_to_queue">Add to queue</option>
        </select>
        {err("defaultSchedulingPolicy")}
      </label>
      {canEdit ? (
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded bg-foreground px-3 py-2 text-background disabled:opacity-60 focus-visible:ring-2"
        >
          {pending ? "Saving…" : "Save settings"}
        </button>
      ) : null}
    </form>
  );
}
