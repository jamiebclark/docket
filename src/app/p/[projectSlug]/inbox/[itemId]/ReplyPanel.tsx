"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonGroup } from "@/components/ui/Button";
import { LocalTime } from "@/components/ui/LocalTime";
import { TextareaField } from "@/components/ui/TextareaField";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { countGraphemes } from "@/providers/text";
import type { DraftView } from "@/server/services/engagement/inbox";
import { dismissItemAction, editDraftAction, requestDraftAction, writeReplyAction } from "../actions";

/** Only `graphemes` and `code_points` are counted live; every declared provider in this entry uses `graphemes`. */
function liveCount(text: string, countingRule: string): number {
  return countingRule === "code_points" ? [...text].length : countGraphemes(text);
}

/** One draft's place in the item's history: what it was, who acted on it and when, and — for an
 * approved one — where its send stands. Rendered for every draft, not only the live one, so an
 * answered item still shows what was sent (review F13). */
function DraftHistoryEntry({ draft, tz }: { draft: DraftView; tz: string }) {
  const requested = (
    <p className="text-xs text-muted-foreground">
      {draft.origin === "model" ? "Drafted" : "Written"} by {draft.requestedByName ?? "someone no longer on the project"} ·{" "}
      <LocalTime value={draft.createdAt} timeZone={tz} />
    </p>
  );

  if (draft.reviewState === "rejected") {
    return (
      <div className="rounded-lg border border-border p-3">
        {requested}
        <p className="mt-1 text-sm whitespace-pre-wrap">{draft.text}</p>
        <p className="mt-2 text-sm text-danger">Rejected{draft.rejectionReason ? `: ${draft.rejectionReason}` : "."}</p>
      </div>
    );
  }

  if (draft.reviewState === "discarded") {
    return (
      <div className="rounded-lg border border-border p-3 opacity-70">
        {requested}
        <p className="mt-1 text-sm whitespace-pre-wrap">{draft.text}</p>
        <p className="mt-2 text-xs text-muted-foreground">Discarded in favour of a later draft.</p>
      </div>
    );
  }

  if (draft.reviewState === "needs_review") {
    return (
      <div className="rounded-lg border border-border p-3">
        {requested}
        <p className="mt-1 text-sm whitespace-pre-wrap">{draft.text}</p>
        <p className="mt-2 text-sm text-muted-foreground">Awaiting review. Approving one draft discards the other.</p>
      </div>
    );
  }

  if (draft.reviewState !== "approved") return null;

  const approver = draft.reviewedByName ?? "someone no longer on the project";
  return (
    <div className="rounded-lg border border-border p-3">
      {requested}
      <p className="mt-1 text-sm whitespace-pre-wrap">{draft.sendState === "sent" ? draft.sentText : draft.text}</p>
      {draft.sendState === "sent" ? (
        <p className="mt-2 text-sm text-success">
          Sent by {approver} <LocalTime value={draft.sentAt!} timeZone={tz} />
          {draft.externalReplyUrl ? (
            <>
              {" "}
              ·{" "}
              <a href={draft.externalReplyUrl} target="_blank" rel="noreferrer" className="underline">
                View
              </a>
            </>
          ) : null}
        </p>
      ) : draft.sendState === "waiting" || draft.sendState === "sending" ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Approved by {approver} · Waiting to send{draft.sendWaitReason ? `: ${draft.sendWaitReason}` : "."}
        </p>
      ) : draft.sendState === "failed" || draft.sendState === "ambiguous" ? (
        <p className="mt-2 text-sm text-danger">
          {draft.sendState === "ambiguous" ? "Send outcome unknown" : "Send failed"}
          {draft.lastError ? `: ${draft.lastError}` : "."} Needs a decision — see Failures.
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">Approved by {approver}.</p>
      )}
    </div>
  );
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
  tz,
}: {
  slug: string;
  itemId: string;
  drafts: DraftView[];
  canReply: boolean;
  canDismiss: boolean;
  replyable: boolean;
  dismissed: boolean;
  countingRule: string;
  maxLength: number;
  tz: string;
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

      {(() => {
        const history = drafts
          .filter((d) => d.id !== pending1?.id)
          .map((d) => ({ draft: d, node: DraftHistoryEntry({ draft: d, tz }) }))
          .filter((h) => h.node !== null);
        if (history.length === 0) return null;
        return (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Draft history</p>
            {history.map((h) => (
              <div key={h.draft.id}>{h.node}</div>
            ))}
          </div>
        );
      })()}

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
