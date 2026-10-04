"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { MediaPicker } from "@/components/media/MediaPicker";
import { Button } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { Select } from "@/components/ui/Select";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { MediaView } from "@/server/services/media";
import { generateSingleAction } from "./actions";
import {
  APPROVAL_LABEL,
  SCHEDULING_LABEL,
  counterLabel,
  freshRequestId,
  groupByPlatform,
  imageWarning,
  LIMITS,
  maxImagesFor,
  platformsNeedingImage,
  type AccountOption,
} from "./generate-logic";

export interface VoiceOption {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface GenerateFormProps {
  slug: string;
  profiles: VoiceOption[];
  accounts: AccountOption[];
  defaults: { approval: keyof typeof APPROVAL_LABEL; scheduling: keyof typeof SCHEDULING_LABEL };
  mediaEnabled: boolean;
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
      <p id={hintId} className="text-xs text-foreground/70">
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
        className="rounded-md border border-foreground/40 bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
      />
      <p id={countId} className={`text-right text-xs ${props.value.length > props.max ? "text-red-700 dark:text-red-400" : "text-foreground/70"}`}>
        {counterLabel(props.value.length, props.max)}
      </p>
    </div>
  );
}

export function GenerateForm({ slug, profiles, accounts, defaults, mediaEnabled, initial }: GenerateFormProps) {
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
  const [pending, start] = useTransition();
  const busy = pending || initial?.pending === true;

  const selected = accounts.filter((a) => chosen.includes(a.id));
  const maxImages = maxImagesFor(selected);
  const needImage = platformsNeedingImage(selected, media.length);

  function submit(id: string) {
    setRequestId(id);
    setError("");
    setFieldErrors({});
    start(async () => {
      const result = await generateSingleAction(slug, {
        requestId: id,
        voiceProfileId,
        brief,
        sourceText: sourceText || null,
        instructions: instructions || null,
        targetAccountIds: chosen,
        mediaIds: media.map((m) => m.id),
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
    <form
      className="flex max-w-2xl flex-col gap-5"
      aria-label="Generate a post"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) submit(requestId || freshRequestId());
      }}
    >
      <input type="hidden" name="requestId" value={requestId} />

      <Select
        id={`${uid}-voice`}
        label="Voice profile"
        hint="How the post should sound."
        value={voiceProfileId}
        onChange={(e) => setVoiceProfileId(e.target.value)}
        {...(fieldErrors.voiceProfileId ? { error: fieldErrors.voiceProfileId } : {})}
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.isDefault ? " (default)" : ""}
          </option>
        ))}
      </Select>

      <TextArea
        id={`${uid}-brief`}
        label="Brief"
        hint="What the post is about. Required."
        value={brief}
        max={LIMITS.brief}
        rows={4}
        required
        onChange={setBrief}
      />
      {fieldErrors.brief ? <p className="text-xs text-red-700 dark:text-red-400">{fieldErrors.brief}</p> : null}

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

      <fieldset className="flex flex-col gap-3" aria-describedby={`${uid}-accounts-hint`}>
        <legend className="text-sm font-semibold">Accounts</legend>
        <p id={`${uid}-accounts-hint`} className="text-xs text-foreground/70">
          One version is written for each platform you choose.
        </p>
        {groupByPlatform(accounts).map((group) => (
          <div key={group.providerName} className="flex flex-col gap-1">
            <p className="text-xs font-medium uppercase tracking-wide text-foreground/70">{group.providerName}</p>
            {group.accounts.map((a) => (
              <label key={a.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={chosen.includes(a.id)}
                  disabled={!a.providerAvailable}
                  onChange={(e) => setChosen((c) => (e.target.checked ? [...c, a.id] : c.filter((x) => x !== a.id)))}
                />
                <span>{a.displayName}</span>
                <StatusBadge status={a.status} />
              </label>
            ))}
          </div>
        ))}
        {fieldErrors.targetAccountIds ? (
          <p className="text-xs text-red-700 dark:text-red-400">{fieldErrors.targetAccountIds}</p>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold">Images</legend>
        {selected.length > 0 ? (
          <p className="text-xs text-foreground/70">
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
          <p key={name} role="note" className="rounded-md border border-amber-700 p-2 text-sm text-amber-900 dark:border-amber-400 dark:text-amber-300">
            Warning: {imageWarning(name)}
          </p>
        ))}
      </fieldset>

      <p className="text-sm text-foreground/80">
        Review: {APPROVAL_LABEL[defaults.approval]}. Scheduling: {SCHEDULING_LABEL[defaults.scheduling]}. (Project defaults.)
      </p>

      {error ? (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-md border border-red-700 p-3 text-sm dark:border-red-400">
          <p>Error: {error}</p>
          <Button variant="secondary" onClick={() => submit(freshRequestId())} disabled={busy}>
            Try again
          </Button>
        </div>
      ) : null}
      <LiveRegion message={busy ? "Generating…" : error ? `Error: ${error}` : ""} />

      <div className="flex justify-end">
        <Button type="submit" pending={busy} pendingLabel="Generating…" disabled={busy || chosen.length === 0}>
          Generate
        </Button>
      </div>
    </form>
  );
}
