"use client";

import { useState } from "react";
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

function Radios<T extends string>(props: {
  name: string;
  legend: string;
  value: T | null;
  defaultLabel: string;
  options: { value: T; label: string; disabled?: boolean; help?: string; helpId?: string }[];
  onChange: (v: T | null) => void;
}) {
  const choices: { value: T | null; label: string; disabled?: boolean; help?: string; helpId?: string }[] = [
    { value: null, label: `Use project default (${props.defaultLabel})` },
    ...props.options,
  ];
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm font-medium">{props.legend}</legend>
      {choices.map((c) => (
        <div key={c.value ?? "default"} className="flex flex-col">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={props.name}
              checked={props.value === c.value}
              disabled={c.disabled === true}
              {...(c.helpId ? { "aria-describedby": c.helpId } : {})}
              onChange={() => props.onChange(c.value)}
            />
            {c.label}
          </label>
          {c.help ? (
            <p id={c.helpId} className="ml-6 text-xs text-foreground/70">
              {c.help}
            </p>
          ) : null}
        </div>
      ))}
    </fieldset>
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
        className="flex flex-col gap-2 rounded-md border-2 border-amber-700 p-3 dark:border-amber-400"
        aria-describedby={explainId}
      >
        <legend className="px-1 text-sm font-semibold">Review and scheduling</legend>
        <p className="text-sm font-semibold">{UNREVIEWED_QUEUE_LABEL}</p>
        <p id={explainId} className="text-xs text-foreground/80">
          {UNREVIEWED_QUEUE_EXPLANATION}
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            required
            checked={value.confirmUnreviewedQueue}
            aria-invalid={error ? true : undefined}
            onChange={(e) => onChange({ ...value, confirmUnreviewedQueue: e.target.checked })}
          />
          {UNREVIEWED_QUEUE_CONFIRM}
        </label>
        {error ? <p className="text-xs text-red-700 dark:text-red-400">{error}</p> : null}
        <button type="button" className="self-start text-sm underline" onClick={() => setExpanded(true)}>
          Change review and scheduling
        </button>
      </fieldset>
    );
  }

  return (
    <fieldset className="flex flex-col gap-3" aria-describedby={explainId}>
      <legend className="text-sm font-semibold">Review and scheduling</legend>
      <Radios<Approval>
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
      <Radios<Scheduling>
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
          <p id={explainId} className="text-xs text-foreground/80">
            {UNREVIEWED_QUEUE_EXPLANATION}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              required
              checked={value.confirmUnreviewedQueue}
              onChange={(e) => onChange({ ...value, confirmUnreviewedQueue: e.target.checked })}
            />
            {UNREVIEWED_QUEUE_CONFIRM}
          </label>
        </>
      ) : null}
      {error ? <p className="text-xs text-red-700 dark:text-red-400">{error}</p> : null}
    </fieldset>
  );
}
