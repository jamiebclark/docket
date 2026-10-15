"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonGroup } from "@/components/ui/Button";
import { TextareaField } from "@/components/ui/TextareaField";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { countGraphemes } from "@/providers/text";
import type { EngagementDraftRow } from "@/server/dal";
import { dismissItemAction, editDraftAction, requestDraftAction, writeReplyAction } from "../actions";

/** Only `graphemes` and `code_points` are counted live; every declared provider in this entry uses `graphemes`. */
function liveCount(text: string, countingRule: string): number {
  return countingRule === "code_points" ? [...text].length : countGraphemes(text);
}

export function ReplyPanel({
  slug,
  itemId,
  drafts,
  canReply,
  canDismiss,
  replyable,
  dismissed,
  countingRule,
  maxLength,
}: {
  slug: string;
  itemId: string;
  drafts: EngagementDraftRow[];
  canReply: boolean;
  canDismiss: boolean;
  replyable: boolean;
  dismissed: boolean;
  countingRule: string;
  maxLength: number;
}) {
  const router = useRouter();
  const uid = useId();
  const pending1 = drafts.find((d) => d.reviewState === "needs_review") ?? null;
  const [text, setText] = useState(pending1?.text ?? "");
  const [editing, setEditing] = useState(false);
  const [writing, setWriting] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  const count = liveCount(editing ? text : draftText, countingRule);

  function requestDraftNow() {
    setMessage("");
    start(async () => {
      const r = await requestDraftAction(slug, { itemId });
      if (!r.ok) return setMessage(`Error: ${r.message}`);
      if (!r.data.ok) return setMessage(r.data.message);
      router.refresh();
    });
  }

  function writeReplyNow() {
    setMessage("");
    start(async () => {
      const r = await writeReplyAction(slug, { itemId, text: draftText });
      if (!r.ok) return setMessage(`Error: ${r.message}`);
      if (!r.data.ok) return setMessage(r.data.message);
      setWriting(false);
      setDraftText("");
      router.refresh();
    });
  }

  function saveEdit() {
    if (!pending1) return;
    setMessage("");
    start(async () => {
      const r = await editDraftAction(slug, { itemId, draftId: pending1.id, text });
      if (!r.ok) return setMessage(`Error: ${r.message}`);
      if (!r.data.ok) return setMessage(r.data.message);
      setEditing(false);
      router.refresh();
    });
  }

  function dismiss() {
    setMessage("");
    start(async () => {
      const r = await dismissItemAction(slug, { itemId });
      if (!r.ok) return setMessage(`Error: ${r.message}`);
      router.refresh();
    });
  }

  const over = maxLength > 0 && count > maxLength;

  return (
    <div className="mt-4 flex flex-col gap-3">
      {pending1 ? (
        <div className="rounded-lg border border-border p-3">
          <p className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Draft reply
            <Badge tone="info">{pending1.origin === "model" ? "Drafted" : "Written"}</Badge>
          </p>
          {editing ? (
            <>
              <TextareaField
                id={`${uid}-edit`}
                label="Edit this draft"
                minRows={3}
                maxRows={12}
                value={text}
                onChange={(e) => setText(e.target.value)}
                counter={<span className={over ? "font-semibold text-danger" : ""}>{count} / {maxLength}</span>}
              />
              <div className="mt-2 flex gap-2">
                <Button onClick={saveEdit} pending={pending} pendingLabel="Saving…">
                  Save
                </Button>
                <Button variant="secondary" onClick={() => { setEditing(false); setText(pending1.text); }}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm whitespace-pre-wrap">{pending1.text}</p>
              {canReply ? (
                <Button
                  variant="secondary"
                  className="mt-2"
                  onClick={() => {
                    setText(pending1.text);
                    setEditing(true);
                  }}
                >
                  Edit
                </Button>
              ) : null}
              <p className="mt-2 text-sm text-muted-foreground">Approve or reject this on the Review page.</p>
            </>
          )}
        </div>
      ) : canReply && replyable ? (
        writing ? (
          <div className="rounded-lg border border-border p-3">
            <TextareaField
              id={`${uid}-write`}
              label="Write a reply"
              minRows={3}
              maxRows={12}
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              counter={<span className={over ? "font-semibold text-danger" : ""}>{count} / {maxLength}</span>}
            />
            <div className="mt-2 flex gap-2">
              <Button onClick={writeReplyNow} pending={pending} pendingLabel="Saving…" disabled={draftText.trim() === ""}>
                Save reply
              </Button>
              <Button variant="secondary" onClick={() => { setWriting(false); setDraftText(""); }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <ButtonGroup label="Reply">
            <Button onClick={requestDraftNow} pending={pending} pendingLabel="Drafting…">
              Request a draft
            </Button>
            <Button variant="secondary" onClick={() => setWriting(true)}>
              Write a reply
            </Button>
          </ButtonGroup>
        )
      ) : null}

      {canDismiss && !dismissed ? (
        <div>
          <Button variant="secondary" onClick={dismiss} pending={pending} pendingLabel="Dismissing…">
            Dismiss
          </Button>
        </div>
      ) : null}

      <LiveRegion message={message} />
      {message ? (
        <p role="alert" className="text-sm text-danger">
          {message}
        </p>
      ) : null}
    </div>
  );
}
