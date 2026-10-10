"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { LiveRegion } from "@/components/ui/LiveRegion";
import type { VoiceContent } from "@/lib/validation/voice";
import { archiveVoiceAction, createVoiceAction, saveVoiceAction, setDefaultVoiceAction } from "./actions";
import { TryItPanel } from "./TryItPanel";
import {
  EXAMPLES_MAX,
  FIELD_MAX,
  LINKS_MAX,
  normaliseHashtags,
  toContent,
  toFormState,
  type VoiceFormState,
} from "./voice-logic";

export interface AccountOption {
  id: string;
  displayName: string;
  providerKey: string;
  providerName: string;
  postingInstructions: string | null;
}

export interface VoiceEditorProps {
  slug: string;
  canManage: boolean;
  /** Absent when creating. */
  profile?: { id: string; version: number; versionId: string; isDefault: boolean };
  initialName: string;
  initialContent: VoiceContent;
  /** The project's accounts, in list order; Try it lets the reader pick among them. */
  accounts: AccountOption[];
  /** Starting state for server rendering and tests. */
  initial?: { conflict?: boolean; message?: string };
}

const box =
  "rounded-md border border-input bg-surface px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

export function Area(props: {
  id: string;
  label: string;
  value: string;
  rows?: number;
  readOnly: boolean;
  max?: number;
  hint?: string;
  error?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={props.id} className="text-sm font-medium">
        {props.label}
      </label>
      {props.hint ? (
        <p id={`${props.id}-hint`} className="text-xs text-muted-foreground">
          {props.hint}
        </p>
      ) : null}
      <textarea
        id={props.id}
        rows={props.rows ?? 3}
        value={props.value}
        readOnly={props.readOnly}
        maxLength={props.max ? props.max * 2 : undefined}
        onChange={(e) => props.onChange(e.target.value)}
        aria-describedby={[props.hint ? `${props.id}-hint` : "", props.error ? `${props.id}-error` : ""].filter(Boolean).join(" ") || undefined}
        className={box}
      />
      {props.error ? <p id={`${props.id}-error`} className="text-xs text-danger">{props.error}</p> : null}
    </div>
  );
}

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-card">
      <legend className="px-1 text-sm font-semibold">{legend}</legend>
      {children}
    </fieldset>
  );
}

export function VoiceEditor(props: VoiceEditorProps) {
  const { slug, canManage, profile, accounts } = props;
  const readOnly = !canManage;
  const router = useRouter();
  const uid = useId();
  const [form, setForm] = useState<VoiceFormState>(() => toFormState(props.initialName, props.initialContent));
  const [version, setVersion] = useState(profile?.version ?? 0);
  const [isDefault, setIsDefault] = useState(profile?.isDefault ?? false);
  const [conflict, setConflict] = useState(props.initial?.conflict ?? false);
  const [message, setMessage] = useState(props.initial?.message ?? "");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [pending, start] = useTransition();

  const set = <K extends keyof VoiceFormState>(key: K, value: VoiceFormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  function run(fn: () => Promise<void>) {
    setError("");
    setMessage("");
    setFieldErrors({});
    start(fn);
  }

  function save() {
    run(async () => {
      const content = toContent(form);
      if (!profile) {
        const r = await createVoiceAction(slug, { name: form.name, content });
        if (r.ok) router.push(`/p/${slug}/voice/${r.data.profileId}`);
        else {
          setError(r.message);
          setFieldErrors(r.fieldErrors ?? {});
        }
        return;
      }
      const r = await saveVoiceAction(slug, { profileId: profile.id, name: form.name, content, baseVersion: version });
      if (r.ok) {
        setConflict(false);
        setVersion(r.data.version);
        setMessage(`Saved as version ${r.data.version}`);
        router.refresh();
      } else if (r.error === "conflict" && r.message === "This profile changed since you opened it") {
        setConflict(true);
      } else {
        setError(r.message);
        setFieldErrors(r.fieldErrors ?? {});
      }
    });
  }

  function simple(action: typeof setDefaultVoiceAction, done: () => void) {
    run(async () => {
      const r = await action(slug, { profileId: profile!.id });
      if (r.ok) done();
      else setError(r.message);
    });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      {conflict ? (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-md border border-warning-border p-3 text-sm">
          <p>This profile changed since you opened it. Your changes are still here.</p>
          <div className="flex gap-3">
            <Link href={`/p/${slug}/voice/${profile?.id ?? ""}/history?v=${version + 1}`} className="underline">
              View version {version + 1}
            </Link>
            <button type="button" className="underline" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      ) : null}

      <form
        className="flex flex-col gap-5"
        aria-label={profile ? "Edit voice profile" : "New voice profile"}
        onSubmit={(e) => {
          e.preventDefault();
          if (canManage && !pending) save();
        }}
      >
        <Group legend="Basics">
          <Field
            id={`${uid}-name`}
            label="Name"
            value={form.name}
            readOnly={readOnly}
            required
            maxLength={160}
            onChange={(e) => set("name", e.target.value)}
            {...(fieldErrors.name ? { error: fieldErrors.name } : {})}
          />
          {profile ? (
            <p className="text-sm text-muted-foreground">
              Version {version}
              {isDefault ? " · Default profile" : ""}
            </p>
          ) : null}
        </Group>

        <Group legend="Voice">
          <Area id={`${uid}-tone`} label="Voice and tone" hint="How posts sound, e.g. 'warm, plain-spoken, a little dry'." value={form.voiceAndTone} readOnly={readOnly} max={FIELD_MAX} onChange={(v) => set("voiceAndTone", v)} {...(fieldErrors["content.voiceAndTone"] ? { error: fieldErrors["content.voiceAndTone"] } : {})} />
          <Area id={`${uid}-audience`} label="Audience" hint="Who reads this, e.g. 'indie game developers'." value={form.audience} readOnly={readOnly} max={FIELD_MAX} onChange={(v) => set("audience", v)} />
          <Area id={`${uid}-topics`} label="Topics and pillars" hint="What posts are about, e.g. 'release notes, behind the scenes, tips'." value={form.topicsAndPillars} readOnly={readOnly} max={FIELD_MAX} onChange={(v) => set("topicsAndPillars", v)} />
          <Area id={`${uid}-avoid`} label="Avoid" hint="Words, topics or styles to leave out, e.g. 'hype, exclamation marks, competitor names'." value={form.avoid} readOnly={readOnly} max={FIELD_MAX} onChange={(v) => set("avoid", v)} />
        </Group>

        <Group legend="Examples">
          <p className="text-xs text-muted-foreground">Up to {EXAMPLES_MAX} posts that sound right.</p>
          {form.examplePosts.map((text, i) => (
            <div key={i} className="flex flex-col gap-1">
              <Area id={`${uid}-ex-${i}`} label={`Example ${i + 1}`} value={text} rows={3} readOnly={readOnly} onChange={(v) => set("examplePosts", form.examplePosts.map((x, j) => (j === i ? v : x)))} />
              {canManage ? (
                <Button variant="secondary" className="self-start" onClick={() => set("examplePosts", form.examplePosts.filter((_, j) => j !== i))}>
                  Remove example {i + 1}
                </Button>
              ) : null}
            </div>
          ))}
          {canManage && form.examplePosts.length < EXAMPLES_MAX ? (
            <Button variant="secondary" className="self-start" onClick={() => set("examplePosts", [...form.examplePosts, ""])}>
              Add example
            </Button>
          ) : null}
          {readOnly && form.examplePosts.length === 0 ? <p className="text-sm text-muted-foreground">No examples.</p> : null}
        </Group>

        <Group legend="Links and hashtags">
          {form.preferredLinks.map((link, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <Field id={`${uid}-link-${i}`} label={`Link ${i + 1} address`} type="url" value={link.url} readOnly={readOnly} onChange={(e) => set("preferredLinks", form.preferredLinks.map((l, j) => (j === i ? { ...l, url: e.target.value } : l)))} />
              <Field id={`${uid}-linklabel-${i}`} label={`Link ${i + 1} label`} value={link.label} readOnly={readOnly} onChange={(e) => set("preferredLinks", form.preferredLinks.map((l, j) => (j === i ? { ...l, label: e.target.value } : l)))} />
              {canManage ? (
                <Button variant="secondary" onClick={() => set("preferredLinks", form.preferredLinks.filter((_, j) => j !== i))}>
                  Remove link {i + 1}
                </Button>
              ) : null}
            </div>
          ))}
          {canManage && form.preferredLinks.length < LINKS_MAX ? (
            <Button variant="secondary" className="self-start" onClick={() => set("preferredLinks", [...form.preferredLinks, { url: "", label: "" }])}>
              Add link
            </Button>
          ) : null}
          <Field
            id={`${uid}-tags`}
            label="Hashtags"
            hint="Separate with spaces or commas."
            value={form.hashtags}
            readOnly={readOnly}
            onChange={(e) => set("hashtags", e.target.value)}
            onBlur={() => set("hashtags", normaliseHashtags(form.hashtags))}
          />
          <p className="text-sm">
            Per-platform guidance now lives on each account.{" "}
            <Link href={`/p/${slug}/accounts`} className="underline">
              Edit it on Accounts
            </Link>
          </p>
        </Group>

        {error ? (
          <p role="alert" className="rounded-md border border-danger-border p-3 text-sm">
            Error: {error}
          </p>
        ) : null}
        <LiveRegion message={pending ? "Saving…" : message || (error ? `Error: ${error}` : "")} />
        {message ? <p className="text-sm">{message}</p> : null}

        {canManage ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" pending={pending} pendingLabel="Saving…">
              Save
            </Button>
            {profile && !isDefault ? (
              <Button variant="secondary" disabled={pending} onClick={() => simple(setDefaultVoiceAction, () => { setIsDefault(true); router.refresh(); })}>
                Make default
              </Button>
            ) : null}
            {profile ? (
              <Button variant="danger" disabled={pending} onClick={() => setConfirmArchive(true)}>
                Archive
              </Button>
            ) : null}
          </div>
        ) : null}
        {profile ? (
          <Link href={`/p/${slug}/voice/${profile.id}/history`} className="text-sm underline">
            History
          </Link>
        ) : null}
      </form>

      {profile && canManage ? (
        <Dialog open={confirmArchive} onClose={() => setConfirmArchive(false)} title={`Archive ${form.name}?`}>
          <p className="mb-4 text-sm">
            It will no longer be offered when generating. Posts that used it keep their record, and you can restore it later.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmArchive(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmArchive(false);
                simple(archiveVoiceAction, () => router.push(`/p/${slug}/voice`));
              }}
            >
              Archive
            </Button>
          </div>
        </Dialog>
      ) : null}

      {profile ? (
        <TryItPanel
          slug={slug}
          canManage={canManage}
          versionId={profile.versionId}
          draft={() => toContent(form)}
          accounts={accounts}
        />
      ) : null}
    </div>
  );
}
