"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { normaliseInstructions, POSTING_INSTRUCTIONS_MAX } from "@/lib/generation/groups";
import { setPostingInstructionsAction } from "./actions";
import { controlStyles, errorStyles, hintStyles } from "@/components/ui/controls";

const HELP =
  "How posts for this account are written: for example where hashtags go and how many, whether to include the link and where, how a post opens. The brand voice still applies.";

/** Owners and admins only (the page decides); editors get read-only text. */
export function PostingInstructionsForm({
  slug,
  accountId,
  accountName,
  initial,
}: {
  slug: string;
  accountId: string;
  accountName: string;
  initial: string | null;
}) {
  const [text, setText] = useState(initial ?? "");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [pending, start] = useTransition();
  const field = useRef<HTMLTextAreaElement>(null);
  const id = `posting-instructions-${accountId}`;
  const length = (normaliseInstructions(text) ?? "").length;
  const tooLong = length > POSTING_INSTRUCTIONS_MAX;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaved("");
    start(async () => {
      const res = await setPostingInstructionsAction(slug, { accountId, instructions: text });
      if (res.ok) {
        setSaved(res.data.changed ? "Saved." : "No changes.");
        return;
      }
      setError(res.fieldErrors?.instructions ?? res.message);
      field.current?.focus();
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1" aria-label={`Posting instructions for ${accountName}`}>
      <label htmlFor={id} className="text-sm font-medium">
        Posting instructions for {accountName}
      </label>
      <textarea
        ref={field}
        id={id}
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-invalid={error || tooLong ? true : undefined}
        aria-describedby={`${id}-help ${id}-count ${id}-error`}
        className={controlStyles}
      />
      <p id={`${id}-help`} className={hintStyles}>
        {HELP}
      </p>
      <p id={`${id}-count`} className={`text-xs ${tooLong ? "text-danger" : "text-muted-foreground"}`}>
        {tooLong
          ? `${length} / ${POSTING_INSTRUCTIONS_MAX.toLocaleString("en-US")}, too long`
          : `${length} / ${POSTING_INSTRUCTIONS_MAX.toLocaleString("en-US")}`}
      </p>
      <p id={`${id}-error`} aria-live="polite" className={errorStyles}>
        {error}
      </p>
      <div className="flex justify-end">
        <Button type="submit" pending={pending} pendingLabel="Saving…">
          Save
        </Button>
      </div>
      <LiveRegion message={saved} />
    </form>
  );
}
