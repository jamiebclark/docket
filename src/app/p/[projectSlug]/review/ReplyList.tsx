"use client";

import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition } from "react";
import { ActionBar } from "@/components/ui/ActionBar";
import { Button } from "@/components/ui/Button";
import { checkStyles } from "@/components/ui/controls";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { TextareaField } from "@/components/ui/TextareaField";
import type { ReplyQueueRow } from "@/server/services/engagement/review";
import { approveReplyAction, dismissReplyItemsAction } from "./actions";
import { RejectReplyDialog } from "./RejectReplyDialog";
import { toggle, toggleAll } from "./review-logic";

export interface ReplyListProps {
  slug: string;
  items: ReplyQueueRow[];
  canApprove: boolean;
}

export function ReplyList({ slug, items, canApprove }: ReplyListProps) {
  const router = useRouter();
  const uid = useId();
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  const ids = useMemo(() => items.map((i) => i.itemId), [items]);
  const live = selected.filter((s) => ids.includes(s));

  function approve(row: ReplyQueueRow) {
    start(async () => {
      const r = await approveReplyAction(slug, { draftId: row.draft.id });
      if (!r.ok) return setMessage(`Error: ${r.message}`);
      if (!r.data.ok) return setMessage(`Error: ${r.data.message}`);
      setMessage("Approved. It will be sent on the next tick.");
      router.refresh();
    });
  }

  function dismissSelected() {
    start(async () => {
      const r = await dismissReplyItemsAction(slug, { itemIds: live });
      if (!r.ok) return setMessage(`Error: ${r.message}`);
      setMessage(`Dismissed ${r.data.dismissed}.`);
      setSelected([]);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {canApprove ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={ids.length > 0 && ids.every((id) => live.includes(id))}
            onChange={() => setSelected(toggleAll(live, ids))}
            className={checkStyles}
          />
          Select all on this page
        </label>
      ) : null}
      <ul className="flex flex-col gap-4">
        {items.map((row) => {
          const id = `${uid}-${row.draft.id}`;
          const over = row.limit > 0 && row.count > row.limit;
          return (
            <li key={row.draft.id}>
              <article aria-labelledby={`${id}-title`} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-card">
                <div className="flex items-start gap-3">
                  {canApprove ? (
                    <input
                      type="checkbox"
                      aria-label={`Select reply from ${row.author.displayName ?? row.author.handle ?? "unknown author"}`}
                      checked={live.includes(row.itemId)}
                      onChange={() => setSelected(toggle(live, row.itemId))}
                      className={`${checkStyles} mt-1.5`}
                    />
                  ) : null}
                  <h2 id={`${id}-title`} className="text-base font-semibold">
                    {row.author.displayName ?? row.author.handle ?? "Unknown author"}
                  </h2>
                </div>
                <p className="text-xs text-muted-foreground">{row.account.displayName}</p>
                <div className="rounded-md bg-muted p-3">
                  <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Comment</p>
                  <p className="mt-1 text-sm whitespace-pre-wrap">{row.itemText || "(no text)"}</p>
                  {row.parentText ? (
                    <>
                      <p className="mt-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">On</p>
                      <p className="mt-1 text-sm whitespace-pre-wrap">{row.parentText}</p>
                    </>
                  ) : null}
                </div>
                <TextareaField
                  id={id}
                  label="Draft reply"
                  minRows={3}
                  maxRows={10}
                  defaultValue={row.draft.text}
                  readOnly
                  counter={
                    <span className={over ? "font-semibold text-danger" : ""}>
                      {row.count.toLocaleString("en-US")} / {row.limit.toLocaleString("en-US")} {row.countingRule}
                      {over ? " (too long)" : ""}
                    </span>
                  }
                />
                {canApprove ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={() => approve(row)} pending={pending} pendingLabel="Approving…">
                      Approve
                    </Button>
                    <RejectReplyDialog slug={slug} draftId={row.draft.id} text={row.draft.text} />
                  </div>
                ) : null}
              </article>
            </li>
          );
        })}
      </ul>
      {live.length > 0 ? (
        <ActionBar label="Bulk actions" message={<span className="font-medium text-foreground">{live.length} selected</span>}>
          <Button variant="secondary" onClick={() => setSelected([])}>
            Clear selection
          </Button>
          <Button variant="danger" onClick={dismissSelected} pending={pending} pendingLabel="Dismissing…">
            Dismiss selected
          </Button>
        </ActionBar>
      ) : null}
      <LiveRegion message={message} />
      {message ? <p className="text-sm">{message}</p> : null}
    </div>
  );
}
