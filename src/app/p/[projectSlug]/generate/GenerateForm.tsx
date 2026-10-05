"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { MediaPicker } from "@/components/media/MediaPicker";
import { Button } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import type { MediaView } from "@/server/services/media";
import { generateSingleAction, planSeriesAction } from "./actions";
import { SeriesPlanEditor } from "./SeriesPlanEditor";
import { SERIES_COUNT_MAX, SERIES_COUNT_MIN, type Angle } from "./series-logic";
import { PolicyPicker, UNREVIEWED_QUEUE_LABEL, effectivePair, isUnreviewedQueue, type PolicyChoice } from "./PolicyPicker";
import {
  APPROVAL_LABEL,
  SCHEDULING_LABEL,
  counterLabel,
  freshRequestId,
  imageWarning,
  LIMITS,
  maxImagesFor,
  platformsNeedingImage,
  type AccountOption,
} from "./generate-logic";
import { controlStyles } from "@/components/ui/controls";
import { ChoiceField } from "@/components/ui/ChoiceField";
import { ActionBar } from "@/components/ui/ActionBar";
import { AccountPicker } from "@/components/accounts/AccountPicker";

export interface VoiceOption {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface GenerateFormProps {
  slug: string;
  /** `series` plans N angles first; the default writes one post. */
  mode?: "single" | "series";
  profiles: VoiceOption[];
  accounts: AccountOption[];
  defaults: { approval: keyof typeof APPROVAL_LABEL; scheduling: keyof typeof SCHEDULING_LABEL };
  mediaEnabled: boolean;
  /** The user's `generation:auto_approve` capability. */
  canAutoApprove?: boolean;
  /** Starting state for server rendering and tests. */
  initial?: { pending?: boolean; error?: string };
}

function TextArea(props: {
  id: string;
  label: string;
  hint: string;
  value: string;
  max: number;
  rows: number;
  required?: boolean;
  onChange: (v: string) => void;
}) {
  const hintId = `${props.id}-hint`;
  const countId = `${props.id}-count`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={props.id} className="text-sm font-medium">
        {props.label}
      </label>
      <p id={hintId} className="text-xs text-muted-foreground">
        {props.hint}
      </p>
      <textarea
        id={props.id}
        name={props.id}
        rows={props.rows}
        required={props.required}
        value={props.value}
        aria-describedby={`${hintId} ${countId}`}
        onChange={(e) => props.onChange(e.target.value)}
        className={controlStyles}
      />
      <p id={countId} className={`text-right text-xs ${props.value.length > props.max ? "text-danger" : "text-muted-foreground"}`}>
        {counterLabel(props.value.length, props.max)}
      </p>
    </div>
  );
}

export function GenerateForm({ slug, mode = "single", profiles, accounts, defaults, mediaEnabled, canAutoApprove = false, initial }: GenerateFormProps) {
  const router = useRouter();
  const uid = useId();
  const [voiceProfileId, setVoiceProfileId] = useState(profiles.find((p) => p.isDefault)?.id ?? profiles[0]?.id ?? "");
  const [brief, setBrief] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [instructions, setInstructions] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [media, setMedia] = useState<MediaView[]>([]);
  const [requestId, setRequestId] = useState("");
  const [error, setError] = useState(initial?.error ?? "");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState<PolicyChoice>({ approval: null, scheduling: null, confirmUnreviewedQueue: false });
  const [count, setCount] = useState(5);
  const [plan, setPlan] = useState<Angle[] | null>(null);
  const [pending, start] = useTransition();
  const busy = pending || initial?.pending === true;

  const selected = accounts.filter((a) => chosen.includes(a.id));
  const maxImages = maxImagesFor(selected);
  const needImage = platformsNeedingImage(selected, media.length);

  const series = mode === "series";
  const request = {
    voiceProfileId,
    brief,
    sourceText: sourceText || null,
    instructions: instructions || null,
    targetAccountIds: chosen,
    mediaIds: media.map((m) => m.id),
    approval: policy.approval,
    scheduling: policy.scheduling,
    confirmUnreviewedQueue: isUnreviewedQueue(effectivePair(defaults, policy)) && policy.confirmUnreviewedQueue,
  };

  function submitPlan() {
    setError("");
    setFieldErrors({});
    setPlan(null);
    start(async () => {
      const result = await planSeriesAction(slug, { ...request, count });
      if (result.ok && result.data.ok) {
        setPlan(result.data.angles);
      } else if (!result.ok) {
        setError(result.message);
        setFieldErrors(result.fieldErrors ?? {});
      } else if (!result.data.ok) {
        setError(result.data.message);
      }
    });
  }

  function submit(id: string) {
    if (series) return submitPlan();
    setRequestId(id);
    setError("");
    setFieldErrors({});
    start(async () => {
      const result = await generateSingleAction(slug, {
        requestId: id,
        ...request,
      });
      if (result.ok && result.data.ok) {
        router.push(`/p/${slug}/generate/result/${result.data.postId}`);
        return;
      }
      setRequestId(freshRequestId());
      if (!result.ok) {
        setError(result.message);
        setFieldErrors(result.fieldErrors ?? {});
      } else if (!result.data.ok) {
        setError(result.data.message);
      }
    });
  }

  return (
    <>
    <form
      className="flex max-w-2xl flex-col gap-5"
      aria-label={series ? "Plan a series" : "Generate a post"}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) submit(requestId || freshRequestId());
      }}
    >
      <input type="hidden" name="requestId" value={requestId} />
      {isUnreviewedQueue(defaults) ? (
        <p role="note" className="rounded-md border-2 border-warning-border p-2 text-sm font-semibold">
          This project is set to: {UNREVIEWED_QUEUE_LABEL}.
        </p>
      ) : null}

      <ChoiceField
        id={`${uid}-voice`}
        name={`${uid}-voice`}
        label="Voice profile"
        hint="How the post should sound."
        value={voiceProfileId}
        onChange={setVoiceProfileId}
        error={fieldErrors.voiceProfileId}
        options={profiles.map((p) => ({ value: p.id, label: p.isDefault ? `${p.name} (default)` : p.name }))}
      />

      <TextArea
        id={`${uid}-brief`}
        label="Brief"
        hint={series ? "What the series is about. Required." : "What the post is about. Required."}
        value={brief}
        max={LIMITS.brief}
        rows={4}
        required
        onChange={setBrief}
      />
      {fieldErrors.brief ? <p className="text-xs text-danger">{fieldErrors.brief}</p> : null}

      {series ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${uid}-count`} className="text-sm font-medium">
            Number of posts
          </label>
          <p className="text-xs text-muted-foreground">
            {SERIES_COUNT_MIN} to {SERIES_COUNT_MAX}. You can edit the plan before anything is written.
          </p>
          <input
            id={`${uid}-count`}
            type="number"
            min={SERIES_COUNT_MIN}
            max={SERIES_COUNT_MAX}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className={`${controlStyles} w-24`}
          />
          {fieldErrors.count ? <p className="text-xs text-danger">{fieldErrors.count}</p> : null}
        </div>
      ) : null}

      <details>
        <summary className="cursor-pointer text-sm font-medium">Add source text</summary>
        <div className="mt-2">
          <TextArea
            id={`${uid}-source`}
            label="Source text"
            hint="An article or notes to draw from. Optional."
            value={sourceText}
            max={LIMITS.sourceText}
            rows={6}
            onChange={setSourceText}
          />
        </div>
      </details>

      <TextArea
        id={`${uid}-instructions`}
        label="Instructions for this post"
        hint="Anything to do or avoid this time. Optional."
        value={instructions}
        max={LIMITS.instructions}
        rows={3}
        onChange={setInstructions}
      />

      <AccountPicker
        legend="Accounts"
        hint="One version is written for each platform you choose."
        idPrefix={uid}
        showStatus="always"
        value={chosen}
        onChange={setChosen}
        error={fieldErrors.targetAccountIds}
        accounts={accounts.map((a) => ({ ...a, unavailableReason: a.providerAvailable ? null : "This platform is not available." }))}
      />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold">Images</legend>
        {selected.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {maxImages === 0 ? "The chosen accounts do not take images." : `Up to ${maxImages} image${maxImages === 1 ? "" : "s"} for the chosen accounts.`}
          </p>
        ) : null}
        <MediaPicker
          slug={slug}
          enabled={mediaEnabled}
          canEdit
          value={media}
          onChange={(next) => setMedia(maxImages > 0 ? next.slice(0, maxImages) : next)}
        />
        {needImage.map((name) => (
          <p key={name} role="note" className="rounded-md border border-warning-border p-2 text-sm text-warning">
            Warning: {imageWarning(name)}
          </p>
        ))}
      </fieldset>

      <PolicyPicker
        idPrefix={`${uid}-policy`}
        defaults={defaults}
        canAutoApprove={canAutoApprove}
        value={policy}
        onChange={setPolicy}
        error={fieldErrors.confirmUnreviewedQueue ?? fieldErrors.approval}
      />

      {error ? (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-lg border border-danger-border bg-danger-bg p-3 text-sm text-danger">
          <p>Error: {error}</p>
          <Button variant="secondary" onClick={() => submit(freshRequestId())} disabled={busy}>
            Try again
          </Button>
        </div>
      ) : null}
      <LiveRegion message={busy ? (series ? "Planning…" : "Generating…") : error ? `Error: ${error}` : ""} />

      <ActionBar stickyFrom="md" message={chosen.length === 0 ? "Choose at least one account." : undefined}>
        <Button
          type="submit"
          pending={busy}
          pendingLabel={series ? "Planning…" : "Generating…"}
          disabled={busy || chosen.length === 0}
        >
          {series ? "Plan series" : "Generate"}
        </Button>
      </ActionBar>
    </form>
    {plan ? <SeriesPlanEditor slug={slug} request={{ ...request, count }} initialAngles={plan} /> : null}
    </>
  );
}
