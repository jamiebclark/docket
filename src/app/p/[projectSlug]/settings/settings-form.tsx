"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/action-result";
import { UNREVIEWED_QUEUE_CONFIRM, UNREVIEWED_QUEUE_EXPLANATION, UNREVIEWED_QUEUE_LABEL } from "../generate/PolicyPicker";
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
  const [approval, setApproval] = useState(values.defaultApprovalPolicy);
  const [scheduling, setScheduling] = useState(values.defaultSchedulingPolicy);
  const unreviewed = approval === "auto_approve" && scheduling === "add_to_queue";
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
          value={approval}
          onChange={(e) => setApproval(e.target.value as typeof approval)}
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
          value={scheduling}
          onChange={(e) => setScheduling(e.target.value as typeof scheduling)}
          disabled={!canEdit}
          className={input}
          {...a11y("defaultSchedulingPolicy")}
        >
          <option value="leave_as_draft">Leave as draft</option>
          <option value="add_to_queue">Add to queue</option>
        </select>
        {err("defaultSchedulingPolicy")}
      </label>
      {unreviewed ? (
        <div className="flex flex-col gap-2 rounded-md border-2 border-amber-700 p-3 dark:border-amber-400">
          <p className="text-sm font-semibold">{UNREVIEWED_QUEUE_LABEL}</p>
          <p id="unreviewed-explain" className="text-xs text-foreground/80">
            {UNREVIEWED_QUEUE_EXPLANATION}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="confirmUnreviewedQueue"
              required
              disabled={!canEdit}
              aria-describedby={errors.confirmUnreviewedQueue ? "confirmUnreviewedQueue-error" : "unreviewed-explain"}
              aria-invalid={errors.confirmUnreviewedQueue ? true : undefined}
            />
            {UNREVIEWED_QUEUE_CONFIRM}
          </label>
          {err("confirmUnreviewedQueue")}
        </div>
      ) : null}
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
