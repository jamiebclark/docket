"use client";

import { useState } from "react";
import { SegmentedControl, type ChoiceOption } from "@/components/ui/SegmentedControl";
import { checkStyles } from "@/components/ui/controls";
import { APPROVAL_LABEL, SCHEDULING_LABEL } from "./generate-logic";

type Approval = keyof typeof APPROVAL_LABEL;
type Scheduling = keyof typeof SCHEDULING_LABEL;

export interface PolicyChoice {
  /** `null` means "use the project default". */
  approval: Approval | null;
  scheduling: Scheduling | null;
  confirmUnreviewedQueue: boolean;
}

export const UNREVIEWED_QUEUE_LABEL = "Approve and queue automatically — no review";
export const UNREVIEWED_QUEUE_EXPLANATION =
  "Posts that pass every platform check will be approved and put in each account's next free slot without anyone reviewing them. Posts with problems still go to review.";
export const UNREVIEWED_QUEUE_CONFIRM = "I understand these posts will be queued without review";
export const AUTO_APPROVE_REFUSED = "Only owners and admins can auto-approve";

export function effectivePair(
  defaults: { approval: Approval; scheduling: Scheduling },
  choice: Pick<PolicyChoice, "approval" | "scheduling">,
): { approval: Approval; scheduling: Scheduling } {
  return { approval: choice.approval ?? defaults.approval, scheduling: choice.scheduling ?? defaults.scheduling };
}

export const isUnreviewedQueue = (p: { approval: Approval; scheduling: Scheduling }): boolean =>
  p.approval === "auto_approve" && p.scheduling === "add_to_queue";

interface Props {
  idPrefix: string;
  defaults: { approval: Approval; scheduling: Scheduling };
  canAutoApprove: boolean;
  value: PolicyChoice;
  onChange: (next: PolicyChoice) => void;
  error?: string | undefined;
}

/** One policy as option cards: "use the project default" first, then each explicit choice. */
function PolicyChoices<T extends string>(props: {
  name: string;
  legend: string;
  value: T | null;
  defaultLabel: string;
  options: { value: T; label: string; disabled?: boolean; help?: string; helpId?: string }[];
  onChange: (v: T | null) => void;
}) {
  const options: ChoiceOption[] = [
    { value: "", label: `Use project default (${props.defaultLabel})` },
    ...props.options.map((o) => ({
      value: o.value,
      label: o.label,
      ...(o.disabled ? { disabled: true } : {}),
      ...(o.help ? { description: o.help, ...(o.helpId ? { descriptionId: o.helpId } : {}) } : {}),
    })),
  ];
  return (
    <SegmentedControl
      name={props.name}
      label={props.legend}
      layout="cards"
      value={props.value ?? ""}
      onChange={(v) => props.onChange(v === "" ? null : (v as T))}
      options={options}
    />
  );
}

export function PolicyPicker({ idPrefix, defaults, canAutoApprove, value, onChange, error }: Props) {
  const [expanded, setExpanded] = useState(false);
  const effective = effectivePair(defaults, value);
  const unreviewed = isUnreviewedQueue(effective);
  const explainId = `${idPrefix}-unreviewed-explain`;

  if (unreviewed && !expanded) {
    return (
      <fieldset
        className="flex flex-col gap-2 rounded-xl border-2 border-warning-border bg-warning-bg/40 p-4"
        aria-describedby={explainId}
      >
        <legend className="px-1 text-sm font-semibold">Review and scheduling</legend>
        <p className="text-sm font-semibold">{UNREVIEWED_QUEUE_LABEL}</p>
        <p id={explainId} className="text-xs text-muted-foreground">
          {UNREVIEWED_QUEUE_EXPLANATION}
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className={checkStyles}
            required
            checked={value.confirmUnreviewedQueue}
            aria-invalid={error ? true : undefined}
            onChange={(e) => onChange({ ...value, confirmUnreviewedQueue: e.target.checked })}
          />
          {UNREVIEWED_QUEUE_CONFIRM}
        </label>
        {error ? <p className="text-xs text-danger">{error}</p> : null}
        <button type="button" className="self-start text-sm font-medium text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => setExpanded(true)}>
          Change review and scheduling
        </button>
      </fieldset>
    );
  }

  return (
    <fieldset className="flex flex-col gap-4" aria-describedby={explainId}>
      <legend className="text-sm font-semibold">Review and scheduling</legend>
      <PolicyChoices<Approval>
        name={`${idPrefix}-approval`}
        legend="Approval"
        value={value.approval}
        defaultLabel={APPROVAL_LABEL[defaults.approval]}
        options={[
          { value: "review_required", label: APPROVAL_LABEL.review_required },
          {
            value: "auto_approve",
            label: APPROVAL_LABEL.auto_approve,
            disabled: !canAutoApprove,
            ...(canAutoApprove ? {} : { help: AUTO_APPROVE_REFUSED, helpId: `${idPrefix}-auto-help` }),
          },
        ]}
        onChange={(approval) => onChange({ ...value, approval })}
      />
      <PolicyChoices<Scheduling>
        name={`${idPrefix}-scheduling`}
        legend="Scheduling"
        value={value.scheduling}
        defaultLabel={SCHEDULING_LABEL[defaults.scheduling]}
        options={[
          { value: "leave_as_draft", label: SCHEDULING_LABEL.leave_as_draft },
          { value: "add_to_queue", label: SCHEDULING_LABEL.add_to_queue },
        ]}
        onChange={(scheduling) => onChange({ ...value, scheduling })}
      />
      {unreviewed ? (
        <>
          <p id={explainId} className="text-xs text-muted-foreground">
            {UNREVIEWED_QUEUE_EXPLANATION}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className={checkStyles}
              required
              checked={value.confirmUnreviewedQueue}
              onChange={(e) => onChange({ ...value, confirmUnreviewedQueue: e.target.checked })}
            />
            {UNREVIEWED_QUEUE_CONFIRM}
          </label>
        </>
      ) : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </fieldset>
  );
}
