"use client";

import { useId, useRef, useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { MARK_CLOSE, MARK_OPEN, renderTemplate, unknownPlaceholders } from "@/lib/jobs/template";
import { INSTRUCTIONS_MAX } from "@/lib/validation/generation";
import { createJobAction } from "../actions";
import { imageWarning, counterLabel, type AccountOption, APPROVAL_LABEL, SCHEDULING_LABEL } from "../../generate/generate-logic";
import { PolicyPicker, UNREVIEWED_QUEUE_LABEL, effectivePair, isUnreviewedQueue, type PolicyChoice } from "../../generate/PolicyPicker";
import type { VoiceOption } from "../../generate/GenerateForm";
import { controlStyles } from "@/components/ui/controls";
import { ChoiceField } from "@/components/ui/ChoiceField";
import { ActionBar } from "@/components/ui/ActionBar";
import { AccountPicker } from "@/components/accounts/AccountPicker";

export type JobFormSource =
  | { kind: "media"; selection: unknown; includeUsed: boolean }
  | { kind: "csv"; file: File };

export interface JobFormProps {
  slug: string;
  source: JobFormSource;
  /** The read-only summary of what will be generated, rendered by the server page. */
  summary: ReactNode;
  itemCount: number;
  /** Template fields available as `{{name}}`. */
  fields: string[];
  /** The first item's values, for the marked preview. */
  firstFields: Record<string, string> | null;
  emptyByField: Record<string, number>;
  defaultTemplate: string;
  profiles: VoiceOption[];
  accounts: AccountOption[];
  defaults: { approval: keyof typeof APPROVAL_LABEL; scheduling: keyof typeof SCHEDULING_LABEL };
  canAutoApprove: boolean;
}

function flatten(issues: unknown): string[] {
  if (!issues) return [];
  const list = Array.isArray(issues) ? issues : Object.values(issues as Record<string, unknown[]>).flat();
  return (list as { message?: string }[]).map((i) => i.message ?? "").filter(Boolean);
}

const red = "text-xs text-danger";

export function JobForm(props: JobFormProps) {
  const { slug, source, summary, itemCount, fields, firstFields, emptyByField, profiles, accounts, defaults, canAutoApprove } = props;
  const uid = useId();
  const summaryRef = useRef<HTMLDivElement>(null);
  const templateRef = useRef<HTMLTextAreaElement>(null);
  const [voiceProfileId, setVoiceProfileId] = useState(profiles.find((p) => p.isDefault)?.id ?? profiles[0]?.id ?? "");
  const [template, setTemplate] = useState(props.defaultTemplate);
  const [chosen, setChosen] = useState<string[]>([]);
  const [policy, setPolicy] = useState<PolicyChoice>({ approval: null, scheduling: null, confirmUnreviewedQueue: false });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<string[]>([]);
  const [pending, start] = useTransition();

  const unknown = unknownPlaceholders(template, fields);
  const preview = firstFields ? renderTemplate(template, firstFields, { mark: true }) : null;
  const empties = Object.entries(emptyByField).filter(([name, n]) => n > 0 && new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`).test(template));
  const selected = accounts.filter((a) => chosen.includes(a.id));
  const needImage = source.kind === "csv" ? [...new Set(selected.filter((a) => a.mediaRequired).map((a) => a.providerName))] : [];

  function insertField(name: string) {
    const el = templateRef.current;
    const token = `{{${name}}}`;
    if (!el) return setTemplate((t) => t + token);
    const start = el.selectionStart ?? template.length;
    const end = el.selectionEnd ?? start;
    const next = template.slice(0, start) + token + template.slice(end);
    setTemplate(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function submit() {
    setFieldErrors({});
    setIssues([]);
    const body = new FormData();
    body.set(
      "payload",
      JSON.stringify({
        source: source.kind === "csv" ? { kind: "csv" } : { kind: "media", selection: source.selection, includeUsed: source.includeUsed },
        voiceProfileId,
        template,
        targetAccountIds: chosen,
        approval: policy.approval,
        scheduling: policy.scheduling,
        confirmUnreviewedQueue: isUnreviewedQueue(effectivePair(defaults, policy)) && policy.confirmUnreviewedQueue,
      }),
    );
    if (source.kind === "csv") body.set("file", source.file);
    start(async () => {
      const result = await createJobAction(slug, body);
      if (result.ok) return;
      setFieldErrors(result.fieldErrors ?? {});
      const list = flatten(result.issues);
      setIssues(list.length > 0 ? list : result.fieldErrors ? [] : [result.message]);
      requestAnimationFrame(() => summaryRef.current?.focus());
    });
  }

  return (
    <form
      className="flex max-w-2xl flex-col gap-5"
      aria-label="Start a generation job"
      onSubmit={(e) => {
        e.preventDefault();
        if (!pending) submit();
      }}
    >
      {isUnreviewedQueue(defaults) ? (
        <p role="note" className="rounded-md border-2 border-warning-border p-2 text-sm font-semibold">
          This project is set to: {UNREVIEWED_QUEUE_LABEL}.
        </p>
      ) : null}
      {issues.length > 0 ? (
        <div ref={summaryRef} tabIndex={-1} role="alert" className="rounded-md border border-danger-border p-3 text-sm">
          <p className="font-medium">This job can&apos;t be started:</p>
          <ul className="mt-1 list-disc pl-5">
            {issues.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-semibold">Source</legend>
        {summary}
      </fieldset>

      <ChoiceField
        id={`${uid}-voice`}
        name={`${uid}-voice`}
        label="Voice profile"
        hint="How every post should sound."
        value={voiceProfileId}
        onChange={setVoiceProfileId}
        error={fieldErrors.voiceProfileId}
        options={profiles.map((p) => ({ value: p.id, label: p.isDefault ? `${p.name} (default)` : p.name }))}
      />

      <div className="flex flex-col gap-1">
        <label htmlFor={`${uid}-template`} className="text-sm font-medium">
          Instructions template
        </label>
        <p id={`${uid}-template-hint`} className="text-xs text-muted-foreground">
          Written once, used for every item. Available fields:
        </p>
        <ul className="flex flex-wrap gap-1" aria-label="Available fields">
          {fields.map((f) => (
            <li key={f}>
              <button
                type="button"
                onClick={() => insertField(f)}
                className="rounded-full border border-input px-2 py-0.5 font-mono text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {`{{${f}}}`}
              </button>
            </li>
          ))}
        </ul>
        <textarea
          id={`${uid}-template`}
          ref={templateRef}
          rows={5}
          required
          value={template}
          aria-describedby={`${uid}-template-hint ${uid}-template-count`}
          aria-invalid={fieldErrors.template ? true : undefined}
          onChange={(e) => setTemplate(e.target.value)}
          className={controlStyles}
        />
        <p id={`${uid}-template-count`} className={`text-right text-xs ${template.length > INSTRUCTIONS_MAX ? "text-danger" : "text-muted-foreground"}`}>
          {counterLabel(template.length, INSTRUCTIONS_MAX)}
        </p>
        {fieldErrors.template ? <p className={red}>{fieldErrors.template}</p> : null}
        {unknown.map((name) => (
          <p key={name} role="note" className={red}>
            Unknown field: {name}. Available: {fields.join(", ")}.
          </p>
        ))}
        {empties.map(([name, n]) => (
          <p key={name} role="note" className="text-xs text-warning">
            {n} {n === 1 ? "item has" : "items have"} an empty value for {name}.
          </p>
        ))}
        {preview !== null ? (
          <div className="mt-1 rounded-lg border border-border bg-surface p-2">
            <p className="text-xs font-medium">Preview of the first item</p>
            <pre className="mt-1 whitespace-pre-wrap text-sm">{preview}</pre>
            <p className="mt-1 text-xs text-muted-foreground">
              Values from each item are marked {MARK_OPEN} {MARK_CLOSE} so the model treats them as data.
            </p>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <AccountPicker
          legend="Target accounts"
          hint="One version is written for each platform you choose."
          idPrefix={uid}
          showStatus="always"
          value={chosen}
          onChange={setChosen}
          error={fieldErrors.targetAccountIds}
          accounts={accounts.map((a) => ({ ...a, unavailableReason: a.providerAvailable ? null : "This platform is not available." }))}
        />
        {needImage.map((name) => (
          <p key={name} role="note" className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning">
            Warning: {imageWarning(name)}
          </p>
        ))}
      </div>

      <PolicyPicker
        idPrefix={`${uid}-policy`}
        defaults={defaults}
        canAutoApprove={canAutoApprove}
        value={policy}
        onChange={setPolicy}
        error={fieldErrors.confirmUnreviewedQueue ?? fieldErrors.approval}
      />

      <LiveRegion message={pending ? "Starting the job…" : ""} />
      <ActionBar stickyFrom="md" message={chosen.length === 0 ? "Choose at least one account." : undefined}>
        <Button type="submit" pending={pending} pendingLabel="Starting…" disabled={pending || chosen.length === 0 || unknown.length > 0}>
          {`Start job (${itemCount} items)`}
        </Button>
      </ActionBar>
    </form>
  );
}
