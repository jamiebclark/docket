"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/action-result";
import { UNREVIEWED_QUEUE_CONFIRM, UNREVIEWED_QUEUE_EXPLANATION, UNREVIEWED_QUEUE_LABEL } from "../generate/PolicyPicker";
import { updateProjectSettings } from "./actions";
import { buttonStyles } from "@/components/ui/Button";
import { alertStyles } from "@/components/ui/Alert";
import { Field } from "@/components/ui/Field";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { TimeZoneField } from "@/components/ui/TimeZoneField";
import { checkStyles } from "@/components/ui/controls";

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
      <span id={`${n}-error`} className="text-xs text-danger">
        {errors[n]}
      </span>
    ) : null;

  return (
    <form action={action} className="flex max-w-2xl flex-col gap-3">
      <input type="hidden" name="currentSlug" value={values.slug} />
      {!canEdit ? (
        <p className="rounded border border-border px-3 py-2 text-sm">
          Only owners and admins can change project settings.
        </p>
      ) : null}
      {formError ? (
        <p role="alert" className={alertStyles("danger")}>
          {formError}
        </p>
      ) : null}
      {state?.ok ? (
        <p role="status" className="rounded border border-border px-3 py-2 text-sm">
          Settings saved.
        </p>
      ) : null}
      <Field id="name" name="name" label="Name" required defaultValue={values.name} disabled={!canEdit} error={errors.name} />
      <Field
        id="slug"
        name="slug"
        label="URL name"
        hint="Changing this moves the project to a new URL"
        required
        defaultValue={values.slug}
        disabled={!canEdit}
        error={errors.slug}
      />
      <TimeZoneField id="timezone" name="timezone" defaultValue={values.timezone} disabled={!canEdit} error={errors.timezone} />
      <SegmentedControl
        name="defaultApprovalPolicy"
        label="Default approval"
        layout="cards"
        value={approval}
        onChange={(v) => setApproval(v as typeof approval)}
        disabled={!canEdit}
        error={errors.defaultApprovalPolicy}
        options={[
          { value: "review_required", label: "Review required", description: "Generated posts wait in Review until someone approves them." },
          { value: "auto_approve", label: "Auto-approve", description: "Generated posts skip review. Posts that fail platform checks still go to Review." },
        ]}
      />
      <SegmentedControl
        name="defaultSchedulingPolicy"
        label="Default scheduling"
        layout="cards"
        value={scheduling}
        onChange={(v) => setScheduling(v as typeof scheduling)}
        disabled={!canEdit}
        error={errors.defaultSchedulingPolicy}
        options={[
          { value: "leave_as_draft", label: "Leave as draft", description: "Approved posts wait until someone schedules them." },
          { value: "add_to_queue", label: "Add to queue", description: "Approved posts take the next free posting slot." },
        ]}
      />
      {unreviewed ? (
        <div className="flex flex-col gap-2 rounded-md border-2 border-warning-border p-3">
          <p className="text-sm font-semibold">{UNREVIEWED_QUEUE_LABEL}</p>
          <p id="unreviewed-explain" className="text-xs text-muted-foreground">
            {UNREVIEWED_QUEUE_EXPLANATION}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="confirmUnreviewedQueue"
              required
              disabled={!canEdit}
              aria-describedby={errors.confirmUnreviewedQueue ? "confirmUnreviewedQueue-error" : "unreviewed-explain"}
              aria-invalid={errors.confirmUnreviewedQueue ? true : undefined} className={checkStyles} />
            {UNREVIEWED_QUEUE_CONFIRM}
          </label>
          {err("confirmUnreviewedQueue")}
        </div>
      ) : null}
      {canEdit ? (
        <button
          type="submit"
          disabled={pending}
          className={buttonStyles({ variant: "primary", className: "self-start" })}
        >
          {pending ? "Saving…" : "Save settings"}
        </button>
      ) : null}
    </form>
  );
}
