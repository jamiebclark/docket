"use client";

import { useId, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { ActionBar } from "@/components/ui/ActionBar";
import { ChoiceField } from "@/components/ui/ChoiceField";
import { Field } from "@/components/ui/Field";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { TextareaField } from "@/components/ui/TextareaField";
import { AccountPicker } from "@/components/accounts/AccountPicker";
import { IMAGE_PROMPT_MAX } from "@/server/llm/image-generation";
import { BRIEF_MAX, INSTRUCTIONS_MAX } from "@/lib/validation/generation";
import { STANDING_SERIES_NAME_MAX } from "@/lib/validation/standing-series";
import { CADENCE_COUNT_MAX, CADENCE_COUNT_MIN, type CadencePeriod } from "@/lib/series/cadence";
import type { OccurrenceRule } from "@/lib/validation/standing-series";
import {
  ACCOUNTS_HINT,
  groupLimitNotice,
  imageWarning,
  counterLabel,
  type AccountOption,
  APPROVAL_LABEL,
  SCHEDULING_LABEL,
} from "../../generate/generate-logic";
import { PolicyPicker, effectivePair, isUnreviewedQueue, type PolicyChoice } from "../../generate/PolicyPicker";
import type { VoiceOption } from "../../generate/GenerateForm";
import {
  CADENCE_HINT,
  DATED_INSTRUCTIONS_HINT,
  IMAGE_PROMPT_HINT,
  NO_PLACEHOLDERS_HINT,
  STANDING_SERIES_AUTHORISED_NOTE,
  ruleLabel,
} from "./series-logic";
import { createStandingSeriesAction, updateStandingSeriesAction } from "./actions";

type MediaSource = "none" | "pool" | "generate";

export interface StandingSeriesFormValues {
  name: string;
  brief: string;
  template: string;
  voiceProfileId: string;
  targetAccountIds: string[];
  occurrenceRule: OccurrenceRule;
  cadenceCount: number;
  cadencePeriod: CadencePeriod;
  leadDays: number;
  mediaSource: MediaSource;
  mediaTag: string | null;
  imagePrompt: string | null;
  approval: keyof typeof APPROVAL_LABEL | null;
  scheduling: keyof typeof SCHEDULING_LABEL | null;
}

export interface StandingSeriesFormProps {
  slug: string;
  mode: "create" | "edit";
  seriesId?: string;
  initial?: StandingSeriesFormValues;
  profiles: VoiceOption[];
  accounts: AccountOption[];
  mediaTags: string[];
  defaults: { approval: keyof typeof APPROVAL_LABEL; scheduling: keyof typeof SCHEDULING_LABEL };
  canAutoApprove: boolean;
  timezone: string;
}

function flatten(issues: unknown): string[] {
  if (!issues) return [];
  const list = Array.isArray(issues) ? issues : Object.values(issues as Record<string, unknown[]>).flat();
  return (list as { message?: string }[]).map((i) => i.message ?? "").filter(Boolean);
}

export function StandingSeriesForm(props: StandingSeriesFormProps) {
  const { slug, mode, seriesId, profiles, accounts, mediaTags, defaults, canAutoApprove, timezone } = props;
  const uid = useId();
  const summaryRef = useRef<HTMLDivElement>(null);
  const init = props.initial;

  const [name, setName] = useState(init?.name ?? "");
  const [brief, setBrief] = useState(init?.brief ?? "");
  const [template, setTemplate] = useState(init?.template ?? "");
  const [voiceProfileId, setVoiceProfileId] = useState(init?.voiceProfileId ?? profiles.find((p) => p.isDefault)?.id ?? profiles[0]?.id ?? "");
  const [chosen, setChosen] = useState<string[]>(init?.targetAccountIds ?? []);
  const [occurrenceRule, setOccurrenceRule] = useState<OccurrenceRule>(init?.occurrenceRule ?? "cadence");
  const [cadenceCount, setCadenceCount] = useState(init?.cadenceCount ?? 1);
  const [cadencePeriod, setCadencePeriod] = useState<CadencePeriod>(init?.cadencePeriod ?? "week");
  const [leadDays, setLeadDays] = useState(init?.leadDays ?? 0);
  const [mediaSource, setMediaSource] = useState<MediaSource>(init?.mediaSource ?? "none");
  const [mediaTag, setMediaTag] = useState(init?.mediaTag ?? "");
  const [imagePrompt, setImagePrompt] = useState(init?.imagePrompt ?? "");
  const [policy, setPolicy] = useState<PolicyChoice>({
    approval: init?.approval ?? null,
    scheduling: init?.scheduling ?? null,
    confirmUnreviewedQueue: false,
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<string[]>([]);
  const [pending, start] = useTransition();

  const selected = accounts.filter((a) => chosen.includes(a.id));
  const limitNotice = groupLimitNotice(selected);
  const needImage = selected.filter((a) => a.mediaRequired).map((a) => a.providerName);

  function submit() {
    setFieldErrors({});
    setIssues([]);
    const media =
      mediaSource === "none"
        ? { source: "none" as const }
        : mediaSource === "pool"
          ? { source: "pool" as const, tag: mediaTag || null }
          : { source: "generate" as const, prompt: imagePrompt };
    const body = new FormData();
    body.set(
      "payload",
      JSON.stringify({
        name,
        brief,
        template,
        voiceProfileId,
        targetAccountIds: chosen,
        occurrenceRule,
        cadence: occurrenceRule === "cadence" ? { count: cadenceCount, period: cadencePeriod } : null,
        leadDays: occurrenceRule === "dated_list" ? leadDays : 0,
        media,
        approval: policy.approval,
        scheduling: policy.scheduling,
        confirmUnreviewedQueue: isUnreviewedQueue(effectivePair(defaults, policy)) && policy.confirmUnreviewedQueue,
      }),
    );
    start(async () => {
      const result = mode === "create" ? await createStandingSeriesAction(slug, body) : await updateStandingSeriesAction(slug, seriesId!, body);
      if (result.ok) return;
      const errors = result.fieldErrors ?? {};
      setFieldErrors(errors);
      const list = flatten(result.issues);
      setIssues(list.length > 0 ? list : Object.keys(errors).length > 0 ? [] : [result.message]);
      requestAnimationFrame(() => summaryRef.current?.focus());
    });
  }

  return (
    <form
      className="flex max-w-2xl flex-col gap-5"
      aria-label={mode === "create" ? "Create a standing series" : "Edit standing series"}
      onSubmit={(e) => {
        e.preventDefault();
        if (!pending) submit();
      }}
    >
      {issues.length > 0 ? (
        <div ref={summaryRef} tabIndex={-1} role="alert" className="rounded-md border border-danger-border p-3 text-sm">
          <p className="font-medium">This can&apos;t be saved:</p>
          <ul className="mt-1 list-disc pl-5">
            {issues.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Field
        id={`${uid}-name`}
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={STANDING_SERIES_NAME_MAX}
        required
        error={fieldErrors.name}
      />

      <TextareaField
        id={`${uid}-brief`}
        label="What it is about"
        minRows={2}
        maxRows={8}
        required
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        counter={counterLabel(brief.length, BRIEF_MAX)}
        error={fieldErrors.brief}
      />

      <TextareaField
        id={`${uid}-template`}
        label="Instructions for each post"
        minRows={4}
        maxRows={16}
        required
        value={template}
        onChange={(e) => setTemplate(e.target.value)}
        hint={occurrenceRule === "dated_list" ? DATED_INSTRUCTIONS_HINT : NO_PLACEHOLDERS_HINT}
        counter={counterLabel(template.length, INSTRUCTIONS_MAX)}
        error={fieldErrors.template}
      />

      <ChoiceField
        id={`${uid}-voice`}
        name="voiceProfileId"
        label="Voice profile"
        value={voiceProfileId}
        onChange={setVoiceProfileId}
        error={fieldErrors.voiceProfileId}
        options={profiles.map((p) => ({ value: p.id, label: p.isDefault ? `${p.name} (default)` : p.name }))}
      />

      <div className="flex flex-col gap-3">
        <AccountPicker
          legend="Accounts"
          hint={ACCOUNTS_HINT}
          idPrefix={uid}
          showStatus="always"
          value={chosen}
          onChange={setChosen}
          error={fieldErrors.targetAccountIds ?? limitNotice ?? undefined}
          accounts={accounts.map((a) => ({ ...a, unavailableReason: a.providerAvailable ? null : "This platform is not available." }))}
        />
        {[...new Set(needImage)].map((name) => (
          <p key={name} role="note" className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning">
            {imageWarning(name)}
          </p>
        ))}
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-semibold">When it posts</legend>

        {mode === "create" ? (
          <SegmentedControl
            name="occurrenceRule"
            label="Occurrence"
            layout="cards"
            value={occurrenceRule}
            onChange={(v) => setOccurrenceRule(v as OccurrenceRule)}
            options={[
              { value: "cadence", label: "Cadence", description: "A set number of posts per day, week or month." },
              { value: "dated_list", label: "Dated list", description: "One post per row of a spreadsheet of dates, on its own date, every year." },
            ]}
            error={fieldErrors.occurrenceRule}
          />
        ) : (
          <p className="text-sm">
            <span className="font-medium">Occurrence: </span>
            {ruleLabel(occurrenceRule === "cadence" ? { count: cadenceCount, period: cadencePeriod } : null)}
            <br />
            <span className="text-xs text-muted-foreground">
              A series keeps the occurrence rule it was created with. To change it, create another series.
            </span>
          </p>
        )}

        {occurrenceRule === "cadence" ? (
          <>
            <p className="-mt-1 text-xs text-muted-foreground">{CADENCE_HINT(timezone)}</p>
            <div className="flex flex-wrap items-end gap-3">
              <Field
                id={`${uid}-count`}
                label="Posts per period"
                type="number"
                min={CADENCE_COUNT_MIN}
                max={CADENCE_COUNT_MAX}
                value={cadenceCount}
                onChange={(e) => setCadenceCount(Number(e.target.value) || CADENCE_COUNT_MIN)}
                error={fieldErrors["cadence.count"]}
                className="w-28"
              />
              <SegmentedControl
                name="cadencePeriod"
                label="Period"
                value={cadencePeriod}
                onChange={(v) => setCadencePeriod(v as CadencePeriod)}
                options={[
                  { value: "day", label: "Day" },
                  { value: "week", label: "Week" },
                  { value: "month", label: "Month" },
                ]}
                error={fieldErrors["cadence.period"]}
              />
            </div>
          </>
        ) : (
          <Field
            id={`${uid}-leadDays`}
            label="Write each post this many days early"
            type="number"
            min={0}
            max={30}
            value={leadDays}
            onChange={(e) => setLeadDays(Number(e.target.value) || 0)}
            hint="0 means the post is written on the day itself. A lead time is the only protection against a worker that is down on the day."
            error={fieldErrors.leadDays}
            className="w-28"
          />
        )}
      </fieldset>

      <SegmentedControl
        name="mediaSource"
        label="Images"
        layout="cards"
        value={mediaSource}
        onChange={(v) => setMediaSource(v as MediaSource)}
        options={[
          { value: "none", label: "None", description: "Posts are text-only." },
          { value: "pool", label: "From the library", description: "Each post claims an unused image from Media." },
          { value: "generate", label: "Generate one per post", description: "Docket writes a fresh image for every post." },
        ]}
        error={fieldErrors.media}
      />
      {mediaSource === "pool" ? (
        <ChoiceField
          id={`${uid}-tag`}
          name="mediaTag"
          label="Tag (optional)"
          hint="Limit the pool to images with this tag."
          value={mediaTag}
          onChange={setMediaTag}
          options={[{ value: "", label: "Any tag" }, ...mediaTags.map((t) => ({ value: t, label: t }))]}
        />
      ) : null}
      {mediaSource === "generate" ? (
        <TextareaField
          id={`${uid}-prompt`}
          label="Image prompt"
          minRows={2}
          maxRows={8}
          required
          value={imagePrompt}
          onChange={(e) => setImagePrompt(e.target.value)}
          hint={IMAGE_PROMPT_HINT}
          counter={counterLabel(imagePrompt.length, IMAGE_PROMPT_MAX)}
          error={fieldErrors["media.prompt"]}
        />
      ) : null}

      <PolicyPicker
        idPrefix={`${uid}-policy`}
        defaults={defaults}
        canAutoApprove={canAutoApprove}
        value={policy}
        onChange={setPolicy}
        error={fieldErrors.confirmUnreviewedQueue ?? fieldErrors.approval}
      />
      <p className="text-xs text-muted-foreground">{STANDING_SERIES_AUTHORISED_NOTE}</p>

      <LiveRegion message={pending ? "Saving…" : ""} />
      <ActionBar stickyFrom="md" message={chosen.length === 0 ? "Choose at least one account." : undefined}>
        <Button type="submit" pending={pending} pendingLabel="Saving…" disabled={pending || chosen.length === 0}>
          {mode === "create" ? "Create standing series" : "Save"}
        </Button>
      </ActionBar>
    </form>
  );
}
