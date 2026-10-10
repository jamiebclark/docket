"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { normaliseInstructions, POSTING_INSTRUCTIONS_MAX } from "@/lib/generation/groups";
import { setPostingInstructionsAction } from "./actions";
import { TextareaField } from "@/components/ui/TextareaField";

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
      <TextareaField
        ref={field}
        id={id}
        label={`Posting instructions for ${accountName}`}
        hint={HELP}
        minRows={5}
        maxRows={20}
        mono
        value={text}
        onChange={(e) => setText(e.target.value)}
        error={error}
        aria-invalid={error || tooLong ? true : undefined}
        counter={
          tooLong
            ? `${length} / ${POSTING_INSTRUCTIONS_MAX.toLocaleString("en-US")}, too long`
            : `${length} / ${POSTING_INSTRUCTIONS_MAX.toLocaleString("en-US")}`
        }
        counterClassName={`text-xs ${tooLong ? "text-danger" : "text-muted-foreground"}`}
      />
      <div className="flex justify-end">
        <Button type="submit" pending={pending} pendingLabel="Saving…">
          Save
        </Button>
      </div>
      <LiveRegion message={saved} />
    </form>
  );
}
