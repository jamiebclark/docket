"use client";

import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import type { ReviewItem } from "@/server/services/review";
import { RegenerateDialog } from "../generate/result/[postId]/RegenerateDialog";
import { VariantEditor } from "../generate/result/[postId]/VariantEditor";
import { approveAction, bulkApproveAction } from "./actions";
import { RejectDialog } from "./RejectDialog";
import { BRIEF_PREVIEW_MAX, EXCERPT_MAX, bulkDetails, bulkSummary, policyText, toggle, toggleAll, truncate } from "./review-logic";

export interface ReviewListProps {
  slug: string;
  items: ReviewItem[];
  canApprove: boolean;
  canRegenerate: boolean;
}

export function ReviewList({ slug, items, canApprove, canRegenerate }: ReviewListProps) {
  const router = useRouter();
  const uid = useId();
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [details, setDetails] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const ids = useMemo(() => items.map((i) => i.postId), [items]);
  const excerpts = useMemo(() => new Map(items.map((i) => [i.postId, truncate(i.variants[0]?.text ?? "", EXCERPT_MAX)])), [items]);
  const live = selected.filter((s) => ids.includes(s));

  function approve(item: ReviewItem) {
    setDetails([]);
    start(async () => {
      const r = await approveAction(slug, { postId: item.postId });
      if (!r.ok) return setMessage(`Error: ${r.message}`);
      if (!r.data.ok) {
        setMessage(`Error: ${r.data.message}`);
        if (r.data.code === "already_reviewed") router.refresh();
        return;
      }
      const missed = r.data.queued.filter((q) => !q.ok);
      setMessage(missed.length > 0 ? `Approved. Not scheduled: ${missed.map((q) => (q.ok ? "" : q.message)).join(" ")}` : "Approved.");
      router.refresh();
    });
  }

  function approveSelected() {
    start(async () => {
      const r = await bulkApproveAction(slug, { postIds: live });
      if (!r.ok) return setMessage(`Error: ${r.message}`);
      setMessage(bulkSummary(r.data));
      setDetails(bulkDetails(r.data, excerpts));
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
          />
          Select all on this page
        </label>
      ) : null}
      <ul className="flex flex-col gap-4">
        {items.map((item) => {
          const id = `${uid}-${item.postId}`;
          const excerpt = excerpts.get(item.postId) ?? "";
          const policy = policyText(item.schedulingPolicy);
          const blockReason = "Fix the problems below before approving.";
          return (
            <li key={item.postId}>
              <article aria-labelledby={`${id}-title`} className="flex flex-col gap-3 rounded-lg border border-foreground/20 p-4">
                <div className="flex items-start gap-3">
                  {canApprove ? (
                    <input
                      type="checkbox"
                      aria-label={`Select post: ${excerpt}`}
                      checked={live.includes(item.postId)}
                      onChange={() => setSelected(toggle(live, item.postId))}
                      className="mt-1.5"
                    />
                  ) : null}
                  <h2 id={`${id}-title`} className="text-base font-semibold">
                    {excerpt || "(no text)"}
                  </h2>
                </div>
                <p className="text-xs text-foreground/70">
                  {item.voice ? `Voice: ${item.voice.name}, version ${item.voice.version}` : "Voice: unknown"}
                  {policy ? ` · ${policy}` : ""}
                </p>
                {item.brief ? (
                  <p className="text-sm text-foreground/80" title={item.brief}>
                    Brief: {truncate(item.brief, BRIEF_PREVIEW_MAX)}
                  </p>
                ) : null}
                <ul className="flex flex-col gap-2">
                  {item.variants.map((v) => {
                    const over = v.limit > 0 && v.count > v.limit;
                    return (
                      <li key={v.key} className="rounded-md bg-foreground/5 p-3">
                        <p className="text-sm font-medium">
                          {v.displayName}: <span className="font-normal text-foreground/70">{v.accountNames.join(", ")}</span>
                        </p>
                        <p className="whitespace-pre-wrap text-sm">{v.text}</p>
                        <p className={`text-xs ${over ? "font-semibold text-red-700 dark:text-red-400" : "text-foreground/70"}`}>
                          {v.count.toLocaleString("en-US")}
                          {v.limit > 0 ? ` / ${v.limit.toLocaleString("en-US")}` : ""} {v.countingRule}
                          {over ? " (too long)" : ""}
                        </p>
                        {v.issues.length > 0 ? (
                          <ul className="list-disc pl-5 text-sm">
                            {v.issues.map((i, n) => (
                              <li key={n} className={i.severity === "error" ? "text-red-700 dark:text-red-400" : i.severity === "warning" ? "text-amber-800 dark:text-amber-300" : ""}>
                                {i.severity === "error" ? "Error: " : i.severity === "warning" ? "Warning: " : ""}
                                {i.message}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                {canApprove ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      onClick={() => approve(item)}
                      disabled={item.blocking}
                      pending={pending}
                      aria-describedby={item.blocking ? `${id}-reason` : undefined}
                    >
                      Approve
                    </Button>
                    <Button variant="secondary" aria-expanded={editing === item.postId} onClick={() => setEditing(editing === item.postId ? null : item.postId)}>
                      {editing === item.postId ? "Close editor" : "Edit"}
                    </Button>
                    {canRegenerate ? <RegenerateDialog slug={slug} postId={item.postId} /> : null}
                    <RejectDialog slug={slug} postId={item.postId} text={item.variants[0]?.text ?? ""} />
                    {item.blocking ? (
                      <span id={`${id}-reason`} className="text-sm text-red-700 dark:text-red-400">
                        {blockReason}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {editing === item.postId ? (
                  <VariantEditor
                    slug={slug}
                    postId={item.postId}
                    cards={item.variants.map((v) => ({
                      key: v.key,
                      providerKey: v.providerKey,
                      providerName: v.displayName,
                      accountIds: v.accountIds,
                      accountNames: v.accountNames,
                      text: v.text,
                    }))}
                    mediaIds={item.mediaIds}
                    canEdit
                    reviewing
                  />
                ) : null}
              </article>
            </li>
          );
        })}
      </ul>
      {live.length > 0 ? (
        <div className="sticky bottom-0 flex items-center gap-3 border-t border-foreground/20 bg-background py-3" role="region" aria-label="Bulk actions">
          <p className="text-sm font-medium">{live.length} selected</p>
          <Button onClick={approveSelected} pending={pending} pendingLabel="Approving…">
            Approve selected
          </Button>
          <Button variant="secondary" onClick={() => setSelected([])}>
            Clear selection
          </Button>
        </div>
      ) : null}
      <LiveRegion message={message} />
      {message ? <p className="text-sm">{message}</p> : null}
      {details.length > 0 ? (
        <ul className="list-disc pl-5 text-sm">
          {details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
